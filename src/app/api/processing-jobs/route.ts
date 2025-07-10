/* eslint-disable no-var */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
// app/api/processing-jobs/route.ts - Dedicated job status endpoint

import { NextRequest, NextResponse } from "next/server";

// This should match the job storage from your main route
// In production, you'd want to use Redis or a database for job storage
declare global {
  var processingJobsGlobal: Map<string, any> | undefined;
}

// Use global variable to share job state across API routes
const getJobStorage = () => {
  if (!global.processingJobsGlobal) {
    global.processingJobsGlobal = new Map();
  }
  return global.processingJobsGlobal;
};

// GET endpoint for checking job status
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (!jobId) {
      return NextResponse.json(
        { error: "jobId is required" },
        { status: 400 }
      );
    }

    const processingJobs = getJobStorage();
    const job = processingJobs.get(jobId);
    
    if (!job) {
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      job,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error checking job status:", error);
    return NextResponse.json(
      { error: "Failed to check job status" },
      { status: 500 }
    );
  }
}

// GET endpoint for listing all active jobs
export async function POST(request: NextRequest) {
  try {
    const processingJobs = getJobStorage();
    const activeJobs = Array.from(processingJobs.values())
      .filter(job => job.status === 'processing' || job.status === 'queued')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({
      success: true,
      jobs: activeJobs,
      count: activeJobs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error listing active jobs:", error);
    return NextResponse.json(
      { error: "Failed to list active jobs" },
      { status: 500 }
    );
  }
}

// DELETE endpoint for cancelling a job (if needed)
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (!jobId) {
      return NextResponse.json(
        { error: "jobId is required" },
        { status: 400 }
      );
    }

    const processingJobs = getJobStorage();
    const job = processingJobs.get(jobId);
    
    if (!job) {
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }

    // Mark job as cancelled (the background process should check for this)
    job.status = 'cancelled';
    job.updated_at = new Date().toISOString();

    return NextResponse.json({
      success: true,
      message: "Job cancellation requested",
      job,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error cancelling job:", error);
    return NextResponse.json(
      { error: "Failed to cancel job" },
      { status: 500 }
    );
  }
}