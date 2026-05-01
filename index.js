const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const logger = require('./middleware/logger');
const { authLimiter, generalLimiter } = require('./middleware/rateLimiter');
const versionCheck = require('./middleware/versionCheck');
const app = express();
app.set('trust proxy', 1);
const fetch = require('node-fetch');
const crypto = require('crypto');
const PORT = process.env.PORT || 8000;
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { uuidv7 } = require('uuidv7');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const jwt = require('jsonwebtoken');
const { Parser } = require('json2csv');
// const pendingAuth = new Map();



app.use(express.json());
app.use(logger);
app.use(cookieParser());

app.use(cors({
    origin: 'https://insighta-web-rho.vercel.app', 
    credentials: true 
}));

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1] || req.cookies.access_token;

    if (!token) {
        return res.status(401).json({ status: "error", message: "Authentication token required" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ status: "error", message: "Invalid or expired token" });
        }
        
        req.user = user;
        next();
    });
};

const requireRole = (role) => (req, res, next) => {
    if (!req.user || req.user.role !== role) {
        return res.status(403).json({ status: "error", message: "Forbidden" });
    }
    next();
};

app.use('/auth', authLimiter);

app.use('/api', generalLimiter, versionCheck);

app.get('/auth/github', async (req, res) => {
    const state = req.query.state || crypto.randomBytes(16).toString('hex');
    const code_challenge = req.query.code_challenge; // CLI sends this, web sends nothing

    // Always store — web flow stores with null code_challenge
    const { error: insertError } = await supabase.from('auth_state').insert({
        state: state,
        code_challenge: code_challenge || null,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });

    if (insertError) {
        console.error('Failed to store auth state:', insertError);
        return res.status(500).json({ status: "error", message: "Failed to initiate auth" });
    }

    const rootUrl = 'https://github.com/login/oauth/authorize';
    const options = {
        client_id: process.env.GITHUB_CLIENT_ID,
        redirect_uri: 'https://user-profiler-api.vercel.app/auth/github/callback',
        scope: 'user:email',
        state: state
    };
    const queryString = new URLSearchParams(options).toString();
    res.redirect(`${rootUrl}?${queryString}`);
});

// app.post('/auth/github/callback', async (req, res) => {
//     const { code, code_verifier } = req.body;

//     if (!code || !code_verifier) {
//         return res.status(400).json({ status: 'error', message: 'Code and Verifier required' });
//     }

//     try {
//         // 1. Exchange the 'code' for a GitHub Access Token
//         // This proves to GitHub that the user actually logged in
//         const githubResponse = await axios.post('https://github.com/login/oauth/access_token', {
//             client_id: process.env.GITHUB_CLIENT_ID,
//             client_secret: process.env.GITHUB_CLIENT_SECRET,
//             code: code,
//         }, {
//             headers: { Accept: 'application/json' }
//         });

//         const githubToken = githubResponse.data.access_token;

//         // 2. Get User Info from GitHub
//         const userResponse = await axios.get('https://api.github.com/user', {
//             headers: { Authorization: `token ${githubToken}` }
//         });

//         const { id, login, email, avatar_url } = userResponse.data;

//         // 3. Upsert User in Supabase (Create or Update)
//         const { data: user, error } = await supabase
//             .from('users')
//             .upsert({ 
//                 github_id: id.toString(), 
//                 username: login, 
//                 email, 
//                 avatar_url,
//                 last_login_at: new Date() 
//             }, { onConflict: 'github_id' })
//             .select()
//             .single();

//         if (error) throw error;

//         // 4. Generate YOUR System's Tokens (JWT)
//         const access_token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '3m' });
//         const refresh_token = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '5m' });

//         // 5. Send tokens back to the CLI
//         res.json({
//             status: 'success',
//             access_token,
//             refresh_token
//         });

//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ status: 'error', message: 'Authentication failed' });
//     }
// });

app.get('/auth/github/callback', async (req, res) => {
    const { code, state, code_verifier } = req.query;
    console.log("Callback received with code:", code);

    // 1. Validate state exists
    if (!state) {
        return res.status(400).json({ status: "error", message: "Missing state parameter" });
    }

    // 2. Look up state in Supabase
    const { data: pending, error: dbError } = await supabase
        .from('auth_state')
        .select('*')
        .eq('state', state)
        .single();

    if (dbError || !pending || new Date(pending.expires_at) < new Date()) {
        return res.status(400).json({ status: "error", message: "Invalid or expired state" });
    }

    // 3. Validate PKCE if this was a CLI flow (code_challenge was stored)
    if (pending.code_challenge) {
        if (!code_verifier) {
            await supabase.from('auth_state').delete().eq('state', state);
            return res.status(400).json({ status: "error", message: "Code verifier required" });
        }

        const expectedChallenge = crypto
            .createHash('sha256')
            .update(code_verifier)
            .digest('base64url');

        if (expectedChallenge !== pending.code_challenge) {
            await supabase.from('auth_state').delete().eq('state', state);
            return res.status(400).json({ status: "error", message: "Invalid code verifier" });
        }
    }

    // 4. Detect if CLI flow — check BEFORE deleting pending
    const isCli = !!pending.code_challenge;

    // 5. Clean up — single use
    await supabase.from('auth_state').delete().eq('state', state);

    if (!code) {
        return res.status(400).json({ status: "error", message: "No code from GitHub" });
    }

    try {
        // 6. Exchange code with GitHub
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                client_id: process.env.GITHUB_CLIENT_ID,
                client_secret: process.env.GITHUB_CLIENT_SECRET,
                code,
                // Only send code_verifier if CLI flow
                ...(isCli && code_verifier ? { code_verifier } : {})
            })
        });
        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            return res.status(400).json({ status: "error", message: "Failed to get GitHub token" });
        }

        // 7. Get GitHub user info
        const userRes = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const githubUser = await userRes.json();

        // 8. Upsert user in Supabase
        const { data: user, error } = await supabase
            .from('users')
            .upsert({
                github_id: githubUser.id.toString(),
                username: githubUser.login,
                avatar_url: githubUser.avatar_url,
                last_login_at: new Date().toISOString()
            }, { onConflict: 'github_id' })
            .select()
            .single();

        if (error) throw error;

        // 9. Issue tokens — use spec-required expiry times
        const accessToken = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '3m' }  // spec says 3 minutes
        );

        const refreshToken = jwt.sign(
            { id: user.id },
            process.env.JWT_REFRESH_SECRET,
            { expiresIn: '5m' }  // spec says 5 minutes
        );

        // 10. Respond differently based on flow
        if (isCli) {
            // CLI — redirect to local callback server with tokens in URL
            const cliRedirect = `http://localhost:3000?access_token=${accessToken}&refresh_token=${refreshToken}`;
            console.log('Redirecting to CLI:', cliRedirect);
            return res.redirect(cliRedirect);
        }

        // Web — set HttpOnly cookie and redirect to dashboard
        res.cookie('access_token', accessToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 3 * 60 * 1000  // 3 minutes, matches token expiry
        });

        res.cookie('refresh_token', refreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 5 * 60 * 1000  // 5 minutes, matches token expiry
        });

        console.log('Redirecting to Web Portal Dashboard');
        return res.redirect('https://insighta-web-rho.vercel.app/dashboard');

    } catch (err) {
        console.error("Auth Error:", err);
        res.status(500).json({ status: "error", message: "Authentication failed" });
    }
});

app.post('/auth/refresh', async (req, res) => {
    const { refresh_token } = req.body;

    if (!refresh_token) {
        return res.status(400).json({ status: "error", message: "Refresh token required" });
    }

    try {
        // 1. Verify the refresh token
        const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
        
        // 2. Get user from DB to make sure they are still active
            const { data: user, error: userError } = await supabase
    .from('users').select('*').eq('id', decoded.id).single();

    if (userError || !user) {
    return res.status(403).json({ status: "error", message: "User not found" });
    }

        // 3. Issue NEW pair (Token Rotation)
        const newAccessToken = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '3m' });
        const newRefreshToken = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '5m' });

        res.status(200).json({
            status: "success",
            access_token: newAccessToken,
            refresh_token: newRefreshToken
        });
    } catch (err) {
        res.status(403).json({ status: "error", message: "Invalid refresh token" });
    }
});

app.post('/auth/logout', (req, res) => {
    res.status(200).json({ 
        status: "success", 
        message: "Logged out successfully. Please delete your local tokens." 
    });
});



// app.use('/auth', authRoutes);



// app.use((req, res, next) => {
//     res.header('Access-Control-Allow-Origin', '*');
//     res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
//     res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
//     if (req.method === 'OPTIONS') return res.status(200).end();
//     next();
// });

app.get('/', (req, res) => {
    res.status(200).json({ status: "success", message: "Name Profiler API is ready" });
});


app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('id, username, role, avatar_url, is_active')
            .eq('id', req.user.id)
            .single();

        if (error || !user) {
            return res.status(404).json({ status: "error", message: "User not found" });
        }

        if (!user.is_active) {
            return res.status(403).json({ status: "error", message: "Account is deactivated" });
        }

        res.status(200).json({
            status: "success",
            data: user
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: "Server failure" });
    }
});

app.get('/api/labs', authenticateToken, async (req, res) => {
    try {
        const { data: labs, error } = await supabase
            .from('labs') // Ensure your table is named 'labs'
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.status(200).json({
            status: "success",
            data: labs
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.post('/api/labs', authenticateToken, async (req, res) => {
  const { name, description } = req.body;

  try {
    const { data, error } = await supabase
      .from('labs')
      .insert([{ 
        name, 
        description, 
        user_id: req.user.id // This comes from your JWT token!
      }])
      .select();

    if (error) throw error;
    res.status(201).json({ status: 'success', data: data[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/labs/:id', authenticateToken, /* adminCheck, */ async (req, res) => {
    
    // Step 2: Grab the ID from the URL
    const { id } = req.params;

    // Step 3: The actual Database Logic
    try {
        const { error } = await supabase
          .from('labs')
          .delete()
          .eq('id', id);

        if (error) throw error;

        // Step 4: The Success Response
        res.json({ status: 'success', message: `Lab ${id} deleted successfully.` });
        
    } catch (err) {
        // Step 5: The Error Response
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/profiles/search', '/api/classify'], authenticateToken, async (req, res) => {
    try {
        const { q, name, gender, country_id, sort_by, order, page, limit } = req.query;
        const queryText = (q || name || "").trim();

        if (!queryText && !gender && !country_id) {
            return res.status(400).json({ status: "error", message: "Unable to interpret query" });
        }

        const validSorts = ['age', 'gender_probability', 'created_at', 'name'];
        if (sort_by && !validSorts.includes(sort_by)) {
            return res.status(400).json({ status: "error", message: "Invalid query parameters" });
        }

        const pageNum = Math.max(1, parseInt(page) || 1);
        let limitNum = parseInt(limit) || 10;
        if (limitNum > 50) limitNum = 50; 
        if (limitNum < 1) limitNum = 1;

        const sortBy = sort_by || 'created_at';
        const isAscending = order === 'asc';
        const from = (pageNum - 1) * limitNum;
        const to = from + limitNum - 1;

        const filters = extractFilters(queryText);
        let query = supabase
            .from('profiles')
            .select('*', { count: 'exact' })
            .order(sortBy, { ascending: isAscending })
            .range(from, to);

        if (filters.gender) query = query.eq('gender', filters.gender);
        if (filters.country_id) query = query.eq('country_id', filters.country_id.toUpperCase());
        if (filters.min_age) query = query.gte('age', filters.min_age);
        if (filters.max_age) query = query.lte('age', filters.max_age);

        if (!Object.keys(filters).length) {
            query = query.ilike('name', `%${queryText}%`);
        }

        let { data, count, error } = await query;
        if (error) throw error;

        if ((!data || data.length === 0) && !Object.keys(filters).length) {
            try {
                const [gRes, aRes, nRes] = await Promise.all([
                    fetch(`https://api.genderize.io?name=${encodeURIComponent(queryText)}`),
                    fetch(`https://api.agify.io?name=${encodeURIComponent(queryText)}`),
                    fetch(`https://api.nationalize.io?name=${encodeURIComponent(queryText)}`)
                ]);
                const [g, a, n] = await Promise.all([gRes.json(), aRes.json(), nRes.json()]);

                const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
                const isoCode = (n.country?.[0]?.country_id || "XX").toUpperCase();
                let fullName = "Unknown";

                try {
                    if (isoCode !== "XX") fullName = regionNames.of(isoCode);
                } catch (e) {
                    fullName = "Unknown";
                }

                const newProfile = {
                    id: uuidv7(),
                    name: queryText,
                    gender: g.gender || "unknown",
                    gender_probability: parseFloat(g.probability || 0),
                    age: parseInt(a.age || 0),
                    age_group: a.age < 13 ? "child" : a.age < 20 ? "teenager" : a.age < 60 ? "adult" : "senior",
                    country_id: isoCode,
                    country_name: fullName,
                    country_probability: parseFloat(n.country?.[0]?.probability || 0),
                    created_at: new Date().toISOString()
                };

                const { error: insErr } = await supabase.from('profiles').insert([newProfile]);
                if (!insErr) {
                    data = [newProfile];
                    count = 1;
                }
            } catch (apiErr) {
                console.error("Fallback API failed", apiErr);
            }
        }

        const totalRecords = Number(count || 0);
        const totalPages = Math.ceil(totalRecords / limitNum);

        const protocol = req.protocol;
        const host = req.get('host');
        const fullPath = `${protocol}://${host}/api/profiles/search`;

        return res.status(200).json({
            status: "success",
            page: Number(pageNum),
            limit: Number(limitNum),
            total: totalRecords,
            total_pages: totalPages,
            links: {
                self: `${fullPath}?page=${pageNum}&limit=${limitNum}${q ? `&q=${q}` : ''}`,
                next: pageNum < totalPages ? `${fullPath}?page=${pageNum + 1}&limit=${limitNum}${q ? `&q=${q}` : ''}` : null,
                prev: pageNum > 1 ? `${fullPath}?page=${pageNum - 1}&limit=${limitNum}${q ? `&q=${q}` : ''}` : null
            },
            data: data || []
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: "error", message: "Server failure" });
    }
});

app.get('/api/profiles/export', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        // Pull the same filter params as GET /api/profiles
        let { gender, country_id, age_group, min_age, max_age, sort_by, order } = req.query;

        const validSorts = ['age', 'gender_probability', 'created_at', 'name'];
        const sortBy = validSorts.includes(sort_by) ? sort_by : 'created_at';
        const isAscending = order === 'asc';

        // Build the query the same way GET /api/profiles does
        let query = supabase
            .from('profiles')
            .select('id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at')
            .order(sortBy, { ascending: isAscending });

        if (gender)     query = query.ilike('gender', gender);
        if (country_id) query = query.ilike('country_id', country_id);
        if (age_group)  query = query.ilike('age_group', age_group);
        if (min_age)    query = query.gte('age', parseInt(min_age));
        if (max_age)    query = query.lte('age', parseInt(max_age));

        const { data: profiles, error } = await query;
        if (error) throw error;

        // Exact column order required by the spec
        const fields = [
            'id',
            'name', 
            'gender',
            'gender_probability',
            'age',
            'age_group',
            'country_id',
            'country_name',
            'country_probability',
            'created_at'
        ];

        const json2csvParser = new Parser({ fields });
        const csv = json2csvParser.parse(profiles);

        // Timestamp in filename as required
        res.header('Content-Type', 'text/csv');
        res.attachment(`profiles_${Date.now()}.csv`);
        return res.send(csv);

    } catch (err) {
        res.status(500).json({ status: "error", message: "Export failed" });
    }
});


app.post(['/api/profiles', '/api/classify'], authenticateToken, requireRole('admin'), async (req, res) => {
    try{
        const name = req.body.name

        if (!req.body || !isNaN(name)) {
            return res.status(400).json({ status: "error", message: "Missing or empty parameter" });
        }

        if (!name || name.trim() === "" || name === 'undefined') {
        return res.status(422).json({
        status: "error",
        message: "Invalid parameter type"
            });
        }

        const { data: existingProfile } = await supabase
    .from('profiles')
    .select('name')
    .ilike('name', name)
    .single();

if (existingProfile) {
    return res.status(200).json({
        status: "success",
        message: "profile already exists",
        data: existingProfile
    });
}

        const [genderRes, ageRes, nationRes] = await Promise.all([
            fetch(`https://api.genderize.io?name=${name}`),
            fetch(`https://api.agify.io?name=${name}`),
            fetch(`https://api.nationalize.io?name=${name}`)
        ])

        const [genderData, ageData, nationData]  = await Promise.all([genderRes.json(), ageRes.json(), nationRes.json()])
        console.log("JSON parsing finished")

        let externalApi = ""

        if (genderData.gender === null || genderData.count === 0) {
            externalApi = "Genderize"
            return res.status(502).json({
                "status": "error", 
                "message": "Server failure"
            });
        }

        if (ageData.age === null || ageData.age === undefined) {
            externalApi = "Agify"
            return res.status(502).json({
                "status": "error", 
                "message": "Server failure"
            });
        }

        if (!nationData.country || nationData.country.length === 0) {
            externalApi = "Nationalize"
            return res.status(502).json({
                "status": "error", 
                "message": "Server failure"
            });
        }

        let ageGroupData = "unknown"

        if (ageData.age !== null && ageData.age !== undefined){
        if (ageData.age >= 0 && ageData.age <= 12){
            ageGroupData = "child"
        } else if (ageData.age >= 13 && ageData.age <= 19){
            ageGroupData = "teenager"
        } else if(ageData.age >= 20 && ageData.age <= 59){
            ageGroupData = "adult"
        } else if (ageData.age >= 60){
            ageGroupData = "senior"
        }
    }

        if (genderData.error || ageData.error || nationData.error) {
            externalApi = "Upstream API"
            return res.status(502).json({
                status: "error",
                message: "Server failure"
            });
        }

        console.log("--- API DEBUG ---");
        console.log("Nation Data:", JSON.stringify(nationData, null, 2));

        const newProfile = {
                id: uuidv7(),
                name : name,
                gender : genderData?.gender ?? "unknown",
                gender_probability : genderData?.probability ?? 0,
                age : ageData?.age ?? 0,
                age_group: ageGroupData ?? "unknown",
                country_id: nationData?.country?.[0]?.country_id || "unknown",
                country_probability: nationData?.country?.[0]?.probability || 0,
                created_at: new Date().toISOString()
        }

        const { error } = await supabase
            .from('profiles')
            .insert([newProfile]);

            if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ status: "error", message: "Missing or empty parameter" });
            }
            throw error;
        }

        return res.status(201).json({
            status : "success",
            data: newProfile
        });

    } catch (error) {
        console.error(error)
        return res.status(500).json({status: "error", message: "Server failure"})
    }
});



app.get(['/api/profiles', '/api/classify'], authenticateToken, async (req, res) => {
    try {
        let { gender, country_id, age_group, page, limit } = req.query;

        const pageNum = Math.max(1, parseInt(page) || 1);
        let limitNum = parseInt(limit) || 10;
        if (limitNum > 50) limitNum = 50;
        if (limitNum < 1) limitNum = 1;
        
        const from = (pageNum - 1) * limitNum;
        const to = from + limitNum - 1;

        let query = supabase.from('profiles').select('*', { count: 'exact' });

        if (gender) query = query.ilike('gender', gender);
        if (country_id) query = query.ilike('country_id', country_id);
        if (age_group) query = query.ilike('age_group', age_group);

        const { data, count, error } = await query
            .range(from, to)
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Supabase Fetch Error:", error.message);
            return res.status(400).json({ status: "error", message: "Missing or empty parameter" });
        }

        const totalRecords = Number(count || 0);
        const totalPages = Math.ceil(totalRecords / limitNum);
        
        const protocol = req.protocol;
        const host = req.get('host');
        const baseUrl = `${protocol}://${host}/api/profiles`;

        return res.status(200).json({
            status: "success",
            page: Number(pageNum),
            limit: Number(limitNum),
            total: totalRecords,
            total_pages: totalPages,
            links: {
                self: `${baseUrl}?page=${pageNum}&limit=${limitNum}`,
                next: pageNum < totalPages ? `${baseUrl}?page=${pageNum + 1}&limit=${limitNum}` : null,
                prev: pageNum > 1 ? `${baseUrl}?page=${pageNum - 1}&limit=${limitNum}` : null
            },
            data: data || []
        });

    } catch (err) {
        console.error("General GET Error:", err.message);
        return res.status(500).json({ status: "error", message: "Server failure" });
    }
});

app.get(['/api/profiles/:id', '/api/classify/:id'], authenticateToken, async (req, res) => {
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", req.params.id)
        .single();

    if (error || !data) {
        return res.status(404).json({ 
            status: "error", 
            message: "Profile not found" 
        })
    }
    res.status(200).json({
        status: "success",
        data: data
    })
})

app.delete(['/api/profiles/:id', '/api/classify/:id'], authenticateToken, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    
    const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", req.params.id)
        .single();

    if (!profile) {
        return res.status(404).json({
            status: "error",
            message: "Profile not found"
        });
    }
    
    const { error } = await supabase
        .from("profiles")
        .delete()
        .eq("id", req.params.id);

    if (error) {
        return res.status(500).json({
            status: "error",
            message: "Server failure"
        })
    }

     return res.status(204).send()

     
})


function extractFilters(queryText) {
    const filters = {};
    const q = queryText.toLowerCase();

    if (q.includes('male') || q.includes('men')) filters.gender = 'male';
    if (q.includes('female') || q.includes('women')) filters.gender = 'female';

    if (q.includes('young')) {
        filters.min_age = 16;
        filters.max_age = 24;
    }

    if (q.includes('teenager')) filters.age_group = 'teenager';
    if (q.includes('adult')) filters.age_group = 'adult';
    if (q.includes('senior')) filters.age_group = 'senior';
    if (q.includes('child')) filters.age_group = 'child';


    const numbers = q.match(/\d+/);
    if (numbers) {
        const val = parseInt(numbers[0]);
        if (q.includes('above') || q.includes('over') || q.includes('older')) filters.min_age = val;
        if (q.includes('under') || q.includes('below') || q.includes('younger')) filters.max_age = val;
    }

    const countries = {
        'nigeria': 'NG', 'kenya': 'KE', 'angola': 'AO', 
        'benin': 'BJ', 'ghana': 'GH', 'south africa': 'ZA'
    };
    
    for (const [name, code] of Object.entries(countries)) {
        if (q.includes(name)) filters.country_id = code;
    }

    return filters;
}

app.listen(PORT, () => {
    console.log(`Server is running on port http://localhost:${PORT}`);
});

module.exports = app;