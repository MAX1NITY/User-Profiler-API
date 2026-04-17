const express = require('express');
const app = express();
const { v7: uuidv7 } = require('uuid');
const PORT = process.env.PORT || 8000;

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


app.post('/api/profiles', async (req, res) => {
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

        const existingProfile = profiles.find(p => p.data.name.toLowerCase() === name.toLowerCase())

        if (existingProfile) {
            return res.status(200).json({
                status: "success",
                message: "profile already exists",
                data: existingProfile.data
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

        if (genderData.gender === null || genderData.count === 0) {
            const externalApi = "Genderize"
            return res.status(502).json({
                "status": "error", 
                "message": `${externalApi} returned an invalid response`
            });
        }

        if (ageData.age === null || ageData.age === undefined) {
            const externalApi = "Agify"
            return res.status(502).json({
                "status": "error", 
                "message": `${externalApi} returned an invalid response`
            });
        }

        if (!nationData.country || nationData.country.length === 0) {
            const externalApi = "Nationalize"
            return res.status(502).json({
                "status": "error", 
                "message": `${externalApi} returned an invalid response`
            });
        }

        let ageGroupData = "unknown"

        if (ageData.age >= 0 && ageData.age <= 12){
            ageGroupData = "child"
        } else if (ageData.age >= 13 && ageData.age <= 19){
            ageGroupData = "teenager"
        } else if(ageData.age >= 20 && ageData.age <= 59){
            ageGroupData = "adult"
        } else if (ageData.age >= 60){
            ageGroupData = "senior"
        }

        if (genderData.error || ageData.error || nationData.error) {
            return res.status(502).json({
                status: "error",
                message: `${externalApi} returned an invalid response`
    });
}

        console.log("--- API DEBUG ---");
console.log("Nation Data:", JSON.stringify(nationData, null, 2));

        const newProfile = {
            status: "success",
            data: {
                id: uuidv7(),
                name : name,
                gender : genderData?.gender ?? "unknown",
                gender_probability : genderData?.probability ?? 0,
                sample_size : genderData?.count ?? 0,
                age : ageData?.age ?? 0,
                age_group: ageGroupData ?? "unknown",
                country_id: nationData?.country?.[0]?.country_id ?? "unknown",
                country_probability: nationData?.country?.[0]?.probability ?? 0,
                created_at: new Date().toISOString()

            }
        }

        profiles.push(newProfile)
        res.status(201).json(newProfile)

    }catch (error) {
        console.error(error)
        res.status(500).json({status: "error", message: "Upstream or server failure"})
    }
})



app.get("/api/profiles", (req, res) => {
    let {gender, country_id, age_group} = req.query

    let filteredProfiles = [...profiles]

    if (gender) {
        filteredProfiles = filteredProfiles.filter(p => 
            p.data.gender.toLowerCase() === gender.toLowerCase()
        )
    }

    if (country_id) {
        filteredProfiles = filteredProfiles.filter(p => 
            p.data.country_id.toLowerCase() === country_id.toLowerCase()
        )
    }

    if (age_group) {
        filteredProfiles = filteredProfiles.filter(p => 
            p.data.age_group.toLowerCase() === age_group.toLowerCase()
        )
    }

    res.status(200).json({
        status: "success",
        count: filteredProfiles.length,
        data: filteredProfiles
    })
})

app.get("/api/profiles/:id", (req, res) => {
    const id = req.params.id
    const profile = profiles.find(p => p.data.id === id)

    if (!profile) {
        return res.status(404).json({ 
            status: "error", 
            message: "Profile not found" 
        })
    }
    res.status(200).json(profile)
})

app.delete("/api/profiles/:id", (req, res) => {
    const id = req.params.id
    const index = profiles.findIndex(p => p.data.id === id)

    if (index === -1) {
        return res.status(404).json({
            status: "error",
            message: "Profile not found"
        })
    }
     profiles.splice(index, 1)

     res.status(204).send()
})

module.exports = app;