import config from 'config';
import { MongoClient } from 'mongodb';

const uri = config.get<string>('mongodb.connectionString');
const client = new MongoClient(uri);
const database = client.db('personal-assistant');

export { client, database };
