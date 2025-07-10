// app/api/auto-process/route.ts - Auto-trigger background processing

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { startDate, endDate } = body;

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "startDate and endDate are required" },
        { status: 400 }
      );
    }

    console.log(`🚀 Auto-triggering background processing for ${startDate} to ${endDate}`);

    // Trigger the main processing endpoint in the background
    const params = new URLSearchParams({
      startDate,
      endDate,
      processTranscriptions: 'true',
      maxProcessCount: '10', // Process more at once since it's background
    });

    // Determine the base URL for the internal API call
    const baseUrl = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

    // Make the request but don't wait for it - fire and forget
    fetch(`${baseUrl}/api/process-calls?${params}`)
      .then(response => response.json())
      .then(data => {
        if (data.success && data.jobId) {
          console.log(`✅ Auto-triggered background job: ${data.jobId}`);
        } else {
          console.log(`⚠️ Auto-trigger response:`, data);
        }
      })
      .catch(error => {
        console.error(`❌ Auto-trigger failed:`, error);
      });

    // Return immediately
    return NextResponse.json({
      success: true,
      message: "Background processing triggered",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error in auto-trigger:", error);
    return NextResponse.json(
      { error: "Failed to trigger background processing" },
      { status: 500 }
    );
  }
}