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
        WHERE agent_username IS NOT NULL
        AND disposition_title IS NOT NULL
        AND disposition_title NOT IN ('No Answer - No Voicemail Available', 'No Answer - Voicemail Available', 'Engaged', 'Done', 'Invalid Endpoint')
        AND initiation_timestamp >= $1 
        AND initiation_timestamp <= $2
        ORDER BY initiation_timestamp DESC
      `;
      params = [dateRange.start, dateRange.end];
    } else {
      // No date range provided
      query = `
        SELECT * FROM reporting.contact_log 
        WHERE agent_username IS NOT NULL
        AND disposition_title IS NOT NULL
        AND disposition_title NOT IN ('No Answer - No Voicemail Available', 'No Answer - Voicemail Available', 'Engaged', 'Done', 'Invalid Endpoint')
        ORDER BY initiation_timestamp DESC
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
      `SELECT * FROM reporting.contact_log 
       WHERE agent_username IS NOT NULL
       AND disposition_title IS NOT NULL
       AND disposition_title NOT IN ('No Answer - No Voicemail Available', 'No Answer - Voicemail Available', 'Engaged', 'Done', 'Invalid Endpoint')
       ORDER BY initiation_timestamp DESC`
    );
    return result.rows;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}