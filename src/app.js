// Ensures env is loaded locally; Azure ignores .env and uses App Settings.
import 'dotenv/config';
import './functions/sqlSchema.js';
import './functions/sqlQuery.js';

