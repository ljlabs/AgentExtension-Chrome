(function (global) {
  "use strict";

  function safeClone(value) {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function isType(value, type) {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  }

  function attemptCoercion(value, types) {
    if (value === undefined) return value;

    if (types.includes("integer") && typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return parseInt(value, 10);
    }

    if (types.includes("number") && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }

    if (types.includes("boolean") && (value === "true" || value === "false")) {
      return value === "true";
    }

    if (types.includes("null") && (value === "" || value === "null")) {
      return null;
    }

    if (types.includes("string") && value !== null && typeof value !== "object") {
      return String(value);
    }

    if (types.includes("string") && value !== null && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    if (types.includes("object") && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // ignore
      }
    }

    if (types.includes("array") && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return [value];
      }
    }

    return value;
  }

  function normalizeValue(value, schema, path, errors) {
    if (!schema || typeof schema !== "object") return value;

    if (value === undefined && schema.default !== undefined) {
      value = safeClone(schema.default);
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
      const passed = schema.anyOf.some((subSchema) => {
        const tempErrors = [];
        normalizeValue(safeClone(value), subSchema, path, tempErrors);
        return tempErrors.length === 0;
      });

      if (!passed) {
        errors.push({
          path,
          message: "Did not match any allowed alternative.",
          schemaKeyword: "anyOf"
        });
      }
    }

    let types = null;
    if (schema.type) {
      types = Array.isArray(schema.type) ? schema.type : [schema.type];
    }

    if (types && types.length) {
      const alreadyValid = types.some((type) => isType(value, type));
      if (!alreadyValid) {
        value = attemptCoercion(value, types);
      }

      const nowValid = types.some((type) => isType(value, type));
      if (!nowValid) {
        errors.push({
          path,
          message: `Expected ${types.join(" or ")}, received ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}.`
        });
        return value;
      }
    }

    if (Array.isArray(schema.required) && schema.required.length) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push({
          path,
          message: `Expected an object with required fields: ${schema.required.join(", ")}.`
        });
      }
    }

    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.includes(value)) {
        errors.push({
          path,
          message: `Value must be one of: ${JSON.stringify(schema.enum)}.`
        });
      }
    }

    if (typeof value === "string") {
      if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
        errors.push({ path, message: `String must be at least ${schema.minLength} characters.` });
      }

      if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
        errors.push({ path, message: `String must be at most ${schema.maxLength} characters.` });
      }

      if (schema.pattern) {
        try {
          const re = new RegExp(schema.pattern);
          if (!re.test(value)) {
            errors.push({ path, message: `String must match pattern ${schema.pattern}.` });
          }
        } catch {
          errors.push({ path, message: `Invalid pattern in schema: ${schema.pattern}.` });
        }
      }
    }

    if (typeof value === "number") {
      if (Number.isFinite(schema.minimum) && value < schema.minimum) {
        errors.push({ path, message: `Number must be >= ${schema.minimum}.` });
      }

      if (Number.isFinite(schema.maximum) && value > schema.maximum) {
        errors.push({ path, message: `Number must be <= ${schema.maximum}.` });
      }

      if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) {
        errors.push({ path, message: `Number must be > ${schema.exclusiveMinimum}.` });
      }

      if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) {
        errors.push({ path, message: `Number must be < ${schema.exclusiveMaximum}.` });
      }
    }

    if (Array.isArray(value)) {
      if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
        errors.push({ path, message: `Array must have at least ${schema.minItems} items.` });
      }

      if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
        errors.push({ path, message: `Array must have at most ${schema.maxItems} items.` });
      }

      if (schema.items && typeof schema.items === "object") {
        value = value.map((item, index) => normalizeValue(item, schema.items, `${path}[${index}]`, errors));
      }
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const properties = schema.properties || {};

      for (const [key, propSchema] of Object.entries(properties)) {
        if (value[key] === undefined && propSchema && propSchema.default !== undefined) {
          value[key] = safeClone(propSchema.default);
        }

        if (value[key] !== undefined) {
          value[key] = normalizeValue(value[key], propSchema, `${path}.${key}`, errors);
        }
      }

      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (value[key] === undefined || value[key] === null) {
            errors.push({ path: `${path}.${key}`, message: `Required field "${key}" is missing.` });
          }
        }
      }

      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            errors.push({ path: `${path}.${key}`, message: `Unexpected field "${key}" is not allowed.` });
          }
        }
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        for (const [key, val] of Object.entries(value)) {
          if (!(key in properties)) {
            value[key] = normalizeValue(val, schema.additionalProperties, `${path}.${key}`, errors);
          }
        }
      }
    }

    return value;
  }

  function normalizeAndValidate(data, schema) {
    const errors = [];
    const value = normalizeValue(safeClone(data), schema || {}, "$", errors);
    return {
      valid: errors.length === 0,
      errors,
      value
    };
  }

  global.normalizeAndValidate = normalizeAndValidate;
})(globalThis);
