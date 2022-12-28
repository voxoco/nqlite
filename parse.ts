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
    txItems: [],
  };

  // If this is not an array, return error
  if (!Array.isArray(data)) {
    res.error = "Invalid. Not an array";
    console.log(data);
    return res;
  }

  // If this is not an array of arrays, just a simple query
  if (!Array.isArray(data[0])) {
    // Check if this is a transaction (more than 1 item in the array)
    if (data.length > 1) {
      // Make sure it's not a read query
      if (isReadTx(data)) {
        res.error = "Invalid Transaction. SELECT query in transaction";
        console.log(data);
        return res;
      }

      // Make sure data is an array of strings
      for (const d of data) {
        if (typeof d !== "string") {
          res.error = "Invalid Transaction. Not an array of strings";
          console.log(d);
          return res;
        }
      }

      res.txItems = data;
      return res;
    }
    
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

function isReadTx(data: string[]): boolean {
  const found = data.find((q) => isReadQuery(q));
  return found ? true : false;
}

function isReadQuery(q: string): boolean {
  return q.toLowerCase().startsWith("select");
}
