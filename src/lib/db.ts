import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: 5432,
  user: process.env.DB_USER,
  password: `Y2QyNzk5ZjRiMDZmYTYwMDI2NWE1NzhmODUwNjY2`,
  database: process.env.DB_NAME,
});

interface DateRange {
  start: Date;
  end: Date;
}

export async function getContactLogs(dateRange?: DateRange) {
  try {
    let query: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let params: any[] = [];

    if (dateRange) {
      // Use provided date range
      query = `
        SELECT * FROM reporting.contact_log 
      `;
      params = [dateRange.start, dateRange.end];
    } else {
      // Fallback to original 7-day query if no date range provided
      query = `
        SELECT * FROM reporting.contact_log 
      `;
    }

    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

// Alternative function if you want to keep the original function unchanged
export async function getContactLogsByDateRange() {
  try {
    const result = await pool.query(
      `SELECT * FROM reporting.contact_log `
    );
    return result.rows;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}