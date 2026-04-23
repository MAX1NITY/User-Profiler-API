Natural Language Parsing

1. Parsing Approach
   The API employs a Keyword-Based Rule Engine to translate natural language queries into structured database filters. Instead of using heavy Natural Language Processing (NLP) libraries, the parser uses regular expressions (RegEx) and string tokenization to identify intent.The logic follows a three-step pipeline:Tokenization: The input string is converted to lowercase and split into individual terms.Entity Recognition: The parser scans for predefined keywords related to gender, age groups, and geography.Filter Mapping: Detected entities are converted into Supabase-compatible query parameters (e.g., .eq, .gte, .lte).

2. Supported Keywords and Mappings
   The parser identifies the following categories to build the filter object: Gender - male, female, men, women - Maps to the gender column using exact match.
   Age Group - child, adult, senior, young - Maps to the age_group column.
   Numeric Ranges - under [X], older than [X] - Uses lt (less than) or gt (greater than) logic on the age column.
   Geography - AU, US, GB, etc. (ISO codes) - Maps to the country_id column.
3. Logic ExecutionIf the parser detects specific filter keywords, it prioritizes a Filter-Based Search. For example, a query for "female" will trigger a database filter where gender equals female.If no keywords are detected (e.g., a search for "Maximus"), the system defaults to a Fuzzy Name Search using the .ilike() operator, searching the name column for partial or exact matches.

Limitations and Edge Cases

1. Linguistic Limitations
   Complex Conjunctions: The parser does not currently support complex "AND/OR" logic (e.g., "men OR women"). It typically defaults to the first detected gender keyword.
   Negation: The parser cannot handle negative intent. A query for "not female" will likely still trigger a filter for "female" because it recognizes the keyword but not the preceding negation.
   Synonym Depth: While it handles "men" as "male," it does not support more obscure synonyms or slang for age groups or nationalities.

2. Edge Cases Left Out
   Conflicting Keywords: If a query contains "young adult," the parser may struggle if "young" and "adult" are defined as separate logic branches. In the current iteration, the last keyword identified usually takes precedence.
   Ambiguous Names: If a name is also a keyword (e.g., a person named "Young"), the parser will prioritize the "young" age filter rather than searching for the name.
   Non-ISO Country Names: The parser requires standard ISO-3166-1 alpha-2 codes. Searching for "Australia" instead of "AU" will fail to trigger the country filter and instead attempt a name search for "Australia."
   Multiple Numeric Constraints: The parser is designed to handle one age constraint at a time. A query like "between 20 and 30" is not supported; it will likely only capture the first number detected.

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
