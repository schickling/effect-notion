/**
@category JSON
*/
export type JsonObject = { [Key in string]?: JsonValue }

/**
Matches a JSON array.

@category JSON
*/
export type JsonArray = JsonValue[]

/**
Matches any valid JSON primitive value.

@category JSON
*/
export type JsonPrimitive = string | number | boolean | null

/**
Matches any valid JSON value.

@see `Jsonify` if you need to transform a type to one that is assignable to `JsonValue`.

@category JSON
*/
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
