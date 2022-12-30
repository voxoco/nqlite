import { ParseRes } from "./types.ts";

export function parse(data: JSON, t: number): ParseRes {
  const res: ParseRes = {
    error: "",
    simple: true,
    query: "",
    params: [],
    t,
    data,
    isRead: false,
    bulkItems: [],
    bulkParams: [],
  };

  // If this is not an array, return error
  if (!Array.isArray(data)) {
    res.error = "Invalid. Not an array";
    console.log(data);
    return res;
  }

  // If array is empty, return error
  if (!data.length) {
    res.error = "Empty array";
    console.log(data);
    return res;
  }

  // Handle simple query
  if (!Array.isArray(data[0])) {
    // Check if this is really a simple query
    if (data.length === 1) {
      res.query = data[0] as string;
      res.isRead = isReadQuery(res.query);
      return res;
    }

    // Must be a bulk query
    // Make sure it's not a read query
    if (isReadBulk(data)) {
      res.error = "Invalid Bulk. SELECT query in bulk request";
      console.log(data);
      return res;
    }

    // Make sure data is an array of strings
    if (data.find((d) => typeof d !== "string")) {
      res.error = "Invalid Bulk. Not an array of strings";
      console.log(data);
      return res;
    }

    res.bulkItems = data;
    return res;
  }

  // Check for array more than 2 levels deep
  if (Array.isArray(data[0][0])) {
    res.error =
      "Invalid Paramaratized/Named Statement. Array more than 2 levels deep";
    console.log(data);
    return res;
  }

  // At this point, we know it's a paramarized/named statement
  res.simple = false;

  // Check for bulk paramarized/named statements (second array is an array)
  if (data.length > 1 && Array.isArray(data[1])) {
    // Build the bulkItems array
    for (const i of data) {
      const paramRes = paramQueryRes(i);
      const { error, query, params, isRead } = paramRes;

      // If error in paramarized/named statement, return error
      if (error) {
        res.error = error;
        console.log(data);
        return res;
      }

      // If this is a read query, return error
      if (isRead) {
        res.error = "Invalid Bulk. SELECT query in bulk request";
        console.log(data);
        return res;
      }

      res.bulkParams.push({ query, params });
    }

    return res;
  }

  // Must be regular (non bulk) paramarized/named statement
  const paramRes = paramQueryRes(data[0]);
  const { error, query, params, isRead } = paramRes;

  // If error in paramarized/named statement, return error
  if (error) {
    res.error = error;
    console.log(data);
    return res;
  }

  // Shift the first item off the array as the SQL statement
  res.query = query;
  res.isRead = isRead;
  res.params = params;
  return res;
}

function isReadBulk(data: string[]): boolean {
  const found = data.find((q) => isReadQuery(q));
  return found ? true : false;
}

function isReadQuery(q: string): boolean {
  return q.toLowerCase().startsWith("select");
}

function paramQueryRes(data: string[]) {
  const res = {
    error: "",
    query: "",
    params: [] as string[],
    isRead: false,
  };

  // Grab the first item in the array
  const params = Array.from(data);

  // If item has fewer than 2 items, return error
  if (params.length < 2) {
    res.error = "Invalid Paramaratized/Named Statement. Not enough items";
    console.log(params);
    return res;
  }

  // Shift the first item off the array as the SQL statement
  res.query = params.shift() as string;
  res.isRead = isReadQuery(res.query);
  res.params = params;
  return res;
}
