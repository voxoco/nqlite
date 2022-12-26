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
  };

  // If this is not an array, return error
  if (!Array.isArray(data)) {
    res.error = "Invalid. Not an array";
    console.log(data);
    return res;
  }

  // If this is not an array of arrays, just a simple query
  if (!Array.isArray(data[0])) {
    res.query = data[0] as string;
    res.isRead = isReadQuery(res.query);
    return res;
  }

  // If array is nested more than 2 levels, return error
  if (Array.isArray(data[0][0])) {
    res.error =
      "Invalid Paramaratized/Named Statement. Array more than 2 levels deep";
    console.log(data);
    return res;
  }

  // Grab the first item in the array
  const item = Array.from(data[0]);

  // If item has fewer than 2 items, return error
  if (item.length < 2) {
    res.error = "Invalid Paramaratized/Named Statement. Not enough items";
    console.log(item);
    return res;
  }

  // Shift the first item off the array as the SQL statement
  res.query = item.shift();
  res.simple = false;
  res.isRead = isReadQuery(res.query);
  res.params = item;
  return res;
}

function isReadQuery(q: string): boolean {
  return q.toLowerCase().startsWith("select");
}
