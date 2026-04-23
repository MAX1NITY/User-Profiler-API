const express = require('express');
const app = express();
const fetch = require('node-fetch');
const crypto = require('crypto');
const PORT = process.env.PORT || 8000;
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { uuidv7 } = require('uuidv7');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.listen(PORT, () => {
    console.log(`Server is running on port http://localhost:${PORT}`);
});

app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', (req, res) => {
    res.status(200).json({ status: "success", message: "Name Profiler API is ready" });
});


app.get(['/api/profiles/search', '/api/classify'], async (req, res) => {
    try {
        const queryText = req.query.q || req.query.name;
        const sortBy = req.query.sort_by || 'created_at';
        const order = req.query.order === 'desc' ? false : true;
        const page = parseInt(req.query.page) || 1;
        let limit = parseInt(req.query.limit) || 10;

        const validSortColumns = ['age', 'gender_probability', 'created_at', 'name', 'country_probability'];
        if (req.query.sort_by && !validSortColumns.includes(req.query.sort_by)) {
            return res.status(400).json({ 
                status: "error", 
                message: "Missing or empty parameter" 
            });
        }

        if (limit > 50) limit = 50;
        if (limit < 1) limit = 10;

        if (!queryText && req.path.includes('search')) {
            return res.status(400).json({ status: "error", message: "Missing or empty parameter" });
        }

        const filters = extractFilters(queryText || "");
        const offset = (page - 1) * limit;

        let supabaseQuery = supabase
            .from('profiles')
            .select('*', { count: 'exact' })
            .order(sortBy, { ascending: order })
            .range(offset, offset + limit - 1);

        if (filters.gender) supabaseQuery = supabaseQuery.eq('gender', filters.gender);
        if (filters.age_group) supabaseQuery = supabaseQuery.eq('age_group', filters.age_group);
        if (filters.country_id) supabaseQuery = supabaseQuery.eq('country_id', filters.country_id);
        if (filters.min_age) supabaseQuery = supabaseQuery.gte('age', filters.min_age);
        if (filters.max_age) supabaseQuery = supabaseQuery.lte('age', filters.max_age);

        const hasFilters = Object.keys(filters).length > 0;
        if (!hasFilters && queryText) {
            supabaseQuery = supabaseQuery.ilike('name', `%${queryText}%`);
        }

        let { data, count, error } = await supabaseQuery;

        if (error) throw error;

        if ((!data || data.length === 0) && queryText && !hasFilters) {
            const [genderRes, ageRes, nationRes] = await Promise.all([
    fetch(`https://api.genderize.io?name=${queryText}`),
    fetch(`https://api.agify.io?name=${queryText}`),
    fetch(`https://api.nationalize.io?name=${queryText}`)
]);

const [genderData, ageData, nationData] = await Promise.all([
    genderRes.json(), 
    ageRes.json(), 
    nationRes.json()
]);

let ageGroupData = "unknown";
if (ageData.age !== null && ageData.age !== undefined) {
    if (ageData.age <= 12) ageGroupData = "child";
    else if (ageData.age <= 19) ageGroupData = "teenager";
    else if (ageData.age <= 59) ageGroupData = "adult";
    else ageGroupData = "senior";
}

const newProfile = {
    id: uuidv7(), 
    name: queryText,
    gender: genderData?.gender ?? "unknown",
    gender_probability: genderData?.probability ?? 0,
    age: ageData?.age ?? 0,
    age_group: ageGroupData,
    country_id: nationData?.country?.[0]?.country_id || "unknown",
    country_probability: nationData?.country?.[0]?.probability || 0,
    created_at: new Date().toISOString()
};

const { error: insertError } = await supabase
    .from('profiles')
    .insert([newProfile]);

if (insertError) {
    if (insertError.code !== '23505') throw insertError;
}

data = [newProfile];
count = 1;
        }

        return res.status(200).json({
            status: "success",
            data: data,
            pagination: {
                page: page,
                limit: limit,
                total_records: count || 0,
                total_pages: Math.ceil((count || 0) / limit)
            }
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: "error", message: "Server failure" });
    }
});


app.post(['/api/profiles', '/api/classify'], async (req, res) => {
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

        if (existingProfile) {
            return res.status(200).json({
                status: "success",
                message: "profile already exists",
                data: existingProfile
            })
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



app.get(['/api/profiles', '/api/classify'], async (req, res) => {
    try {
        let { gender, country_id, age_group } = req.query;

        let query = supabase.from('profiles').select('*', { count: 'exact' });

        if (gender) query = query.ilike('gender', gender);
        if (country_id) query = query.ilike('country_id', country_id);
        if (age_group) query = query.ilike('age_group', age_group);

        const { data, count, error } = await query;

        if (error) {
            console.error("Supabase Fetch Error:", error.message);
            return res.status(400).json({ status: "error", message: "Missing or empty parameter" });
        }

        return res.status(200).json({
            status: "success",
            count: count || 0,
            data: data || []
        });

    } catch (err) {
        console.error("General GET Error:", err.message);
        return res.status(500).json({ status: "error", message: "Server failure" });
    }
});

app.get(['/api/profiles/:id', '/api/classify/:id'], async (req, res) => {
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

app.delete(['/api/profiles/:id', '/api/classify/:id'], async (req, res) => {
    
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

module.exports = app;