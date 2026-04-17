Profile Management 
A RESTful API built with Node.js and Express that generates user profiles by combining input names
with data from three external identity services. 
Built with Node.js & Express Backend framework 
Insomnia - API testing and documentation
Vercel – Cloud hosting and deployment
External APIs:Genderize.io: Predicts gender based on name.
Agify.io: Predicts age based on name.
Nationalize.io: Predicts nationality based on name. 
Automatically fetches age, gender, and country data for every new profile.
Strict validation of data by enforcing strict null-checks on external API responses.
Error Handling Feature
API EndpointsPOST /api/profiles - Create a profile.
GET /api/profiles - Retrieve all profiles.
GET /api/profiles/:id - Retrieve a specific profile by ID.
DELETE /api/profiles/:id - Remove a profile from the system.
