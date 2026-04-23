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

let profiles = [];

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


app.get('/api/profiles/search', async (req, res) => {
    try {
        const queryText = req.query.q;

        if (!queryText) {
            return res.status(400).json({ status: "error", message: "Invalid query parameters" });
        }

        const extractedFilters = extractFilters(queryText);
        
        let query = supabase.from('profiles').select('*', { count: 'exact' });

        const hasFilters = Object.keys(extractedFilters).length > 0


        if (hasFilters) {
            if (extractedFilters.gender) query = query.eq('gender', extractedFilters.gender);
            if (extractedFilters.age_group) query = query.eq('age_group', extractedFilters.age_group);
            if (extractedFilters.country_id) query = query.eq('country_id', extractedFilters.country_id);
            if (extractedFilters.min_age) query = query.gte('age', extractedFilters.min_age);
            if (extractedFilters.max_age) query = query.lte('age', extractedFilters.max_age);
        } else {
            query = query.ilike('name', `%${queryText}%`);
        }

        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        const { data, count, error } = await query.range(from, to);

        if (error) throw error;

        res.status(200).json({
            status: "success",
            page: page,
            limit: limit,
            total: count,
            data: data
        });

    } catch (err) {
        console.error("Search Logic Error:", err.message);
        return res.status(500).json({ status: "error", message: err.message });
    }
});


app.post(['/api/profiles', '/api/classify'], async (req, res) => {
    try{
        const name = req.body.name

        if (!req.body || !isNaN(name)) {
            return res.status(400).json({ status: "error", message: "Missing or empty name" });
        }

        if (!name || name.trim() === "" || name === 'undefined') {
        return res.status(422).json({
        status: "error",
        message: "Invalid type"
            });
        }

        const existingProfile = profiles.find(p => p.name.toLowerCase() === name.toLowerCase())

        if (existingProfile) {
            return res.status(200).json({
                status: "success",
                message: "profile already exists",
                data: existingProfile
            })
        }

        console.log("Starting fetches...")
        const [genderRes, ageRes, nationRes] = await Promise.all([
            fetch(`https://api.genderize.io?name=${name}`),
            fetch(`https://api.agify.io?name=${name}`),
            fetch(`https://api.nationalize.io?name=${name}`)
        ])

        console.log("Fetches finished. Starting JSON parsing...")

        const [genderData, ageData, nationData]  = await Promise.all([genderRes.json(), ageRes.json(), nationRes.json()])
        console.log("JSON parsing finished")

        let externalApi = ""

        if (genderData.gender === null || genderData.count === 0) {
            externalApi = "Genderize"
            return res.status(502).json({
                "status": "error", 
                "message": `${externalApi} returned an invalid response`
            });
        }

        if (ageData.age === null || ageData.age === undefined) {
            externalApi = "Agify"
            return res.status(502).json({
                "status": "error", 
                "message": `${externalApi} returned an invalid response`
            });
        }

        if (!nationData.country || nationData.country.length === 0) {
            externalApi = "Nationalize"
            return res.status(502).json({
                "status": "error", 
                "message": `${externalApi} returned an invalid response`
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
                message: `${externalApi} returned an invalid response`
            });
        }

        console.log("--- API DEBUG ---");
        console.log("Nation Data:", JSON.stringify(nationData, null, 2));

        const newProfile = {
                id: uuidv7(),
                name : name,
                gender : genderData?.gender ?? "unknown",
                gender_probability : genderData?.probability ?? 0,
                sample_size : genderData?.count ?? 0,
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
                return res.status(400).json({ status: "error", message: "Name already exists" });
            }
            throw error;
        }

        return res.status(201).json({
            status : "success",
            data: newProfile
        });

    } catch (error) {
        console.error(error)
        return res.status(500).json({status: "error", message: "Upstream or server failure"})
    }
});



app.get(['/api/profiles', '/api/classify'], async (req, res) => {
    let {gender, country_id, age_group} = req.query

    let filteredProfiles = [...profiles]

    if (gender) {
        filteredProfiles = filteredProfiles.filter(p => 
            p.gender.toLowerCase() === gender.toLowerCase()
        )
    }

    if (country_id) {
        filteredProfiles = filteredProfiles.filter(p => 
            p.country_id.toLowerCase() === country_id.toLowerCase()
        )
    }

    if (age_group) {
        filteredProfiles = filteredProfiles.filter(p => 
            p.age_group.toLowerCase() === age_group.toLowerCase()
        )
    }

    res.status(200).json({
        status: "success",
        count: filteredProfiles.length,
        data: filteredProfiles
    })
})

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