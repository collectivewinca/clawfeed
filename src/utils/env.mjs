import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let _env = null;

export function loadEnv() {
  if (_env) return _env;
  _env = {};
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) _env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return _env;
}

export function getEnv(key, defaultValue = '') {
  const env = loadEnv();
  return env[key] || process.env[key] || defaultValue;
}

export function getRequiredEnv(key) {
  const env = loadEnv();
  const value = env[key] || process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}