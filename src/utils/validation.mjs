// Simple input validation utilities

export function validateString(value, fieldName, options = {}) {
  const { minLength = 0, maxLength = Infinity, pattern = null, required = false } = options;
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new Error(`${fieldName} is required`);
    }
    return value;
  }
  
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  
  if (value.length < minLength) {
    throw new Error(`${fieldName} must be at least ${minLength} characters`);
  }
  
  if (value.length > maxLength) {
    throw new Error(`${fieldName} must be at most ${maxLength} characters`);
  }
  
  if (pattern && !pattern.test(value)) {
    throw new Error(`${fieldName} has invalid format`);
  }
  
  return value;
}

export function validateNumber(value, fieldName, options = {}) {
  const { min = -Infinity, max = Infinity, required = false } = options;
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new Error(`${fieldName} is required`);
    }
    return undefined;
  }
  
  const num = typeof value === 'number' ? value : parseInt(value, 10);
  
  if (isNaN(num)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  
  if (num < min || num > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}`);
  }
  
  return num;
}

export function validateBoolean(value, fieldName, required = false) {
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`${fieldName} is required`);
    }
    return undefined;
  }
  
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value === 'true' || value === '1';
  }
  if (typeof value === 'number') return value !== 0;
  
  throw new Error(`${fieldName} must be a boolean`);
}

export function validateArray(value, fieldName, options = {}) {
  const { minLength = 0, maxLength = Infinity, itemValidator = null, required = false } = options;
  
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`${fieldName} is required`);
    }
    return value;
  }
  
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  
  if (value.length < minLength) {
    throw new Error(`${fieldName} must have at least ${minLength} items`);
  }
  
  if (value.length > maxLength) {
    throw new Error(`${fieldName} must have at most ${maxLength} items`);
  }
  
  if (itemValidator) {
    for (let i = 0; i < value.length; i++) {
      value[i] = itemValidator(value[i], `${fieldName}[${i}]`);
    }
  }
  
  return value;
}

// Sanitize string to prevent XSS
export function sanitizeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}