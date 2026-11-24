import Database from 'better-sqlite3';
import { initSchema } from './db';

export function createFreshDatabase(): Database.Database {
  const database = new Database(':memory:');
  initSchema(database);
  return database;
}
