/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
// app/api/process-calls/route.ts - Unified call processing workflow

import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { Client } from "ssh2";
import { readFileSync } from "fs";
import * as path from "path";

// Database configuration
const pool = new Pool({
  host: process.env.DB_HOST,
  port: 5432,
  user: process.env.DB_USER,
  password: `Y2QyNzk5ZjRiMDZmYTYwMDI2NWE1NzhmODUwNjY2`,
  database: process.env.DB_NAME,
});

// Supabase configuration
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// SFTP configuration
type SftpConfig = {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  passphrase: string;
};

function getSftpConfig(): SftpConfig {
  return {
    host: process.env.SFTP_HOST!,
    port: parseInt(process.env.SFTP_PORT!),
    username: process.env.SFTP_USERNAME!,
    privateKey: readFileSync(path.resolve(process.env.HOME || "~", ".ssh/sftp_key")),
    passphrase: process.env.SFTP_PASSPHRASE!,
  };
}

// Interfaces
interface DateRange {
  start: Date;
  end: Date;
}

interface CallLog {
  contact_id: string;
  agent_username: string;
  recording_location: string;
  initiation_timestamp: string;
  total_call_time: {
    minutes: number;
    seconds: number;
  };
  campaign_name: string;
  campaign_id: number;
  customer_cli: string;
  agent_hold_time: number;
  total_hold_time: number;
  time_in_queue: number;
  queue_name: string;
  disposition_title: string;
  existsInSupabase?: boolean;
}

interface TranscriptionData {
  contact_id: string;
  recording_location: string;
  transcript_text: string;
  queue_name?: string;
  agent_username: string;
  initiation_timestamp: string;
  speaker_data?: string | null;
  sentiment_analysis?: string | null;
  entities?: string | null;
  categories?: string | null;
  disposition_title?: string;
  call_summary?: string | null;
  campaign_name?: string | null;
  campaign_id?: string | null;
  customer_cli?: string | null;
  agent_hold_time?: number | null;
  total_hold_time?: number | null;
  time_in_queue?: number | null;
  call_duration: string;
  primary_category?: string | null;
}

// Helper function to get contact logs from database
async function getContactLogs(dateRange?: DateRange) {
  try {
    let query: string;
    let params: any[] = [];

    if (dateRange) {
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

// Helper function to check Supabase status for call logs
async function enhanceCallLogsWithSupabaseStatus(logs: CallLog[]): Promise<CallLog[]> {
  try {
    if (logs.length === 0) return logs;

    const contactIds = logs.map(log => log.contact_id);
    
    const { data: existingRecords, error } = await supabase
      .from('call_records')
      .select('contact_id')
      .in('contact_id', contactIds);

    if (error) {
      console.error('Error checking Supabase status:', error);
      return logs.map(log => ({ ...log, existsInSupabase: false }));
    }

    const existingContactIds = new Set(existingRecords?.map(record => record.contact_id) || []);

    return logs.map(log => ({
      ...log,
      existsInSupabase: existingContactIds.has(log.contact_id)
    }));
  } catch (error) {
    console.error('Error enhancing call logs with Supabase status:', error);
    return logs.map(log => ({ ...log, existsInSupabase: false }));
  }
}

// Helper function to construct SFTP paths
function constructSftpPath(filename: string): string[] {
  const possiblePaths = [];
  
  let decodedFilename = filename;
  try {
    decodedFilename = decodeURIComponent(filename);
  } catch (error) {
    console.log(`Could not decode filename: ${filename}`);
  }
  
  if (decodedFilename.includes('/')) {
    let cleanPath = decodedFilename;
    
    if (cleanPath.startsWith('amazon-connect-b1a9c08821e5/')) {
      cleanPath = cleanPath.replace('amazon-connect-b1a9c08821e5/', '');
    }
    
    if (!cleanPath.startsWith('./') && !cleanPath.startsWith('/')) {
      cleanPath = `./${cleanPath}`;
    }
    
    possiblePaths.push(cleanPath);
    
    if (cleanPath.startsWith('./')) {
      possiblePaths.push(cleanPath.substring(2));
    }
  }
  
  const justFilename = decodedFilename.split('/').pop() || decodedFilename;
  
  // Try current date and previous 7 days
  const currentDate = new Date();
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const targetDate = new Date(currentDate);
    targetDate.setDate(currentDate.getDate() - daysBack);
    
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const day = targetDate.getDate();
    
    const datePath = `${year}/${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}`;
    
    possiblePaths.push(`./${datePath}/${justFilename}`);
    possiblePaths.push(`${datePath}/${justFilename}`);
  }
  
  possiblePaths.push(`./${justFilename}`);
  possiblePaths.push(justFilename);
  
  return Array.from(new Set(possiblePaths));
}

// Helper function to download audio file from SFTP
async function downloadAudioFromSftp(filename: string): Promise<Buffer> {
  const sftpConfig = getSftpConfig();
  
  return new Promise<Buffer>((resolve, reject) => {
    const conn = new Client();
    let resolved = false;
    let sftpSession: any = null;

    const cleanup = () => {
      try {
        if (sftpSession) {
          sftpSession.end();
          sftpSession = null;
        }
        conn.end();
      } catch (e) {
        console.log("Cleanup error:", e);
      }
    };

    conn.on("ready", () => {
      console.log("SFTP connection ready for", filename);

      conn.sftp((err, sftp) => {
        if (err) {
          console.error("SFTP session error:", err);
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(new Error("SFTP session error"));
          }
          return;
        }

        sftpSession = sftp;
        const possiblePaths = constructSftpPath(filename);
        console.log(`Searching ${possiblePaths.length} paths for ${filename}`);
        
        let pathIndex = 0;
        
        const tryNextPath = async () => {
          if (resolved) return;
          
          if (pathIndex >= possiblePaths.length) {
            console.error(`File not found in ${possiblePaths.length} paths`);
            if (!resolved) {
              resolved = true;
              cleanup();
              reject(new Error("Audio file not found"));
            }
            return;
          }
          
          const currentPath = possiblePaths[pathIndex];
          console.log(`Trying path ${pathIndex + 1}/${possiblePaths.length}: ${currentPath}`);
          
          try {
            const stats = await new Promise<any>((resolveStats, rejectStats) => {
              sftp.stat(currentPath, (statErr, statsResult) => {
                if (statErr) {
                  rejectStats(statErr);
                } else {
                  resolveStats(statsResult);
                }
              });
            });

            const sizeInMB = stats.size / (1024 * 1024);
            console.log(`Found file: ${sizeInMB.toFixed(2)}MB`);
            
            if (stats.size === 0) {
              console.log(`Empty file, trying next`);
              pathIndex++;
              return tryNextPath();
            }

            if (stats.size < 10000) {
              console.log(`File too small: ${stats.size} bytes`);
              pathIndex++;
              return tryNextPath();
            }

            console.log(`Downloading ${stats.size} bytes`);
            
            const fileData = await new Promise<Buffer>((resolveDownload, rejectDownload) => {
              const fileBuffers: Buffer[] = [];
              let totalBytesReceived = 0;
              
              const readStream = sftp.createReadStream(currentPath, {
                highWaterMark: 256 * 1024,
              });

              readStream.on("error", (readErr: Error) => {
                console.error(`Stream error: ${readErr.message}`);
                rejectDownload(readErr);
              });

              readStream.on("data", (chunk: Buffer) => {
                fileBuffers.push(chunk);
                totalBytesReceived += chunk.length;
                
                if (totalBytesReceived % (1024 * 1024) < chunk.length) {
                  const progress = ((totalBytesReceived / stats.size) * 100).toFixed(0);
                  console.log(`Progress: ${progress}% (${(totalBytesReceived / (1024 * 1024)).toFixed(1)}MB)`);
                }
              });

              readStream.on("end", () => {
                const audioBuffer = Buffer.concat(fileBuffers);
                console.log(`Downloaded: ${audioBuffer.length} bytes`);
                
                if (audioBuffer.length !== stats.size) {
                  rejectDownload(new Error(`Size mismatch: expected ${stats.size}, got ${audioBuffer.length}`));
                } else {
                  resolveDownload(audioBuffer);
                }
              });
            });

            if (!resolved) {
              resolved = true;
              cleanup();
              resolve(fileData);
            }
            return;

          } catch (error) {
            console.log(`Error with path ${pathIndex + 1}: ${error instanceof Error ? error.message : 'Unknown'}`);
            pathIndex++;
            setTimeout(tryNextPath, 200);
          }
        };
        
        tryNextPath();
      });
    });

    conn.on("error", (err) => {
      console.error("SFTP connection error:", err.message);
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error("SFTP connection failed"));
      }
    });

    try {
      conn.connect({
        ...sftpConfig,
        keepaliveInterval: 30000,
        keepaliveCountMax: 10,
        algorithms: {
          compress: ['none'],
        },
        tryKeyboard: false,
      });
    } catch (e) {
      console.error("Connection setup error:", e);
      if (!resolved) {
        resolved = true;
        reject(new Error("Failed to initialize SFTP connection"));
      }
    }
  });
}

// Helper function to upload audio to AssemblyAI
async function uploadToAssemblyAI(audioBuffer: Buffer, apiKey: string): Promise<string> {
  console.log("Uploading audio to AssemblyAI...");
  
  // Convert Buffer to Uint8Array for fetch compatibility
  const uint8Array = new Uint8Array(audioBuffer);
  
  const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/octet-stream",
    },
    body: uint8Array,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`AssemblyAI upload failed: ${uploadResponse.status} - ${errorText}`);
  }

  const { upload_url } = await uploadResponse.json();
  console.log("Audio uploaded to AssemblyAI successfully");
  return upload_url;
}

// Helper function for topic categorization
async function performTopicCategorization(transcriptData: any): Promise<{
  primary_category: string;
  topic_categories: string[];
  confidence: number;
} | null> {
  try {
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://192.168.40.101";

    const response = await fetch(`${serverUrl}/api/openAI/categorise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcriptData }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      console.error("Topic categorization failed:", response.status);
      return null;
    }

    const topicData = await response.json();

    if (topicData.topic_categories && topicData.topic_categories.length > 0) {
      return {
        primary_category: topicData.primary_category,
        topic_categories: topicData.topic_categories,
        confidence: topicData.confidence || 1.0,
      };
    }

    return null;
  } catch (error) {
    console.error("Error in topic categorization:", error);
    return null;
  }
}

// Helper function to transcribe audio with AssemblyAI
async function transcribeAudio(uploadUrl: string, speakerCount: number = 2): Promise<any> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY!;
  
  console.log("Submitting transcription to AssemblyAI...");
  
  const transcriptResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speech_model: "best",
      speaker_labels: true,
      speakers_expected: speakerCount,
      summarization: true,
      summary_model: "conversational",
      summary_type: "paragraph",
      entity_detection: true,
      sentiment_analysis: true,
      filter_profanity: false,
      auto_highlights: true,
      punctuate: true,
      format_text: true,
    }),
  });

  if (!transcriptResponse.ok) {
    const errorData = await transcriptResponse.json();
    throw new Error(`AssemblyAI submission failed: ${JSON.stringify(errorData)}`);
  }

  const { id } = await transcriptResponse.json();
  console.log(`Transcription job created: ${id}`);

  // Poll for completion
  let transcript;
  let status = "processing";
  let attempts = 0;
  const maxAttempts = 120; // 10 minutes at 5-second intervals
  const pollInterval = 5000;

  while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { Authorization: apiKey },
    });

    if (!statusResponse.ok) {
      throw new Error(`Status check failed: ${statusResponse.status}`);
    }

    transcript = await statusResponse.json();
    status = transcript.status;
    
    if (attempts % 12 === 0) { // Log every minute
      console.log(`Transcription status after ${attempts * 5}s: ${status}`);
    }
    
    if (status === "completed" || status === "error") {
      break;
    }
  }

  if (status === "error") {
    throw new Error(`Transcription failed: ${transcript?.error || "Unknown error"}`);
  }

  if (status !== "completed") {
    throw new Error(`Transcription timed out after ${maxAttempts * pollInterval / 1000}s`);
  }

  console.log("Transcription completed successfully");

  // Process speaker roles
  if (transcript.utterances) {
    transcript.utterances = transcript.utterances.map((utterance: any) => ({
      ...utterance,
      speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
    }));
  }

  if (transcript.words) {
    transcript.words = transcript.words.map((word: any) => ({
      ...word,
      speakerRole: word.speaker === "A" ? "Agent" : "Customer",
    }));
  }

  return transcript;
}

// Helper function to save transcription to Supabase
async function saveTranscriptionToSupabase(
  callData: CallLog,
  transcriptData: any,
  categorization: any = null
): Promise<void> {
  try {
    const payload: TranscriptionData = {
      contact_id: callData.contact_id,
      recording_location: callData.recording_location || "",
      transcript_text: transcriptData.text || "",
      queue_name: callData.queue_name || "",
      agent_username: callData.agent_username || "",
      initiation_timestamp: callData.initiation_timestamp || new Date().toISOString(),
      speaker_data: transcriptData.utterances ? JSON.stringify(transcriptData.utterances) : null,
      sentiment_analysis: transcriptData.sentiment_analysis_results ? JSON.stringify(transcriptData.sentiment_analysis_results) : null,
      entities: transcriptData.entities ? JSON.stringify(transcriptData.entities) : null,
      disposition_title: callData.disposition_title || "",
      call_summary: transcriptData.summary || null,
      campaign_name: callData.campaign_name || null,
      campaign_id: callData.campaign_id?.toString() || null,
      customer_cli: callData.customer_cli || null,
      agent_hold_time: callData.agent_hold_time || null,
      total_hold_time: callData.total_hold_time || null,
      time_in_queue: callData.time_in_queue || null,
      call_duration: JSON.stringify(callData.total_call_time) || "",
      categories: categorization?.topic_categories 
        ? JSON.stringify(categorization.topic_categories) 
        : (transcriptData.topic_categorization?.all_topics ? JSON.stringify(transcriptData.topic_categorization.all_topics) : null),
      primary_category: categorization?.primary_category || transcriptData.topic_categorization?.primary_topic || null,
    };

    console.log('Saving transcription to Supabase for contact_id:', payload.contact_id);

    // Check if record already exists
    const { data: existingRecord, error: checkError } = await supabase
      .from('call_records')
      .select('contact_id')
      .eq('contact_id', payload.contact_id)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      throw new Error(`Error checking existing record: ${checkError.message}`);
    }

    if (existingRecord) {
      // Update existing record
      const { error } = await supabase
        .from('call_records')
        .update(payload)
        .eq('contact_id', payload.contact_id);

      if (error) {
        throw new Error(`Failed to update record: ${error.message}`);
      }

      console.log('Successfully updated existing record');
    } else {
      // Insert new record
      const { error } = await supabase
        .from('call_records')
        .insert([payload]);

      if (error) {
        throw new Error(`Failed to insert record: ${error.message}`);
      }

      console.log('Successfully inserted new record');
    }
  } catch (error) {
    console.error("Error saving to Supabase:", error);
    throw error;
  }
}

// Main API handler
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const processTranscriptions = searchParams.get('processTranscriptions') === 'true';
    const maxProcessCount = parseInt(searchParams.get('maxProcessCount') || '5');

    console.log('🚀 Starting unified call processing workflow');

    let dateRange: DateRange | undefined;
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return NextResponse.json(
          { error: 'Invalid date format. Please use ISO date format.' },
          { status: 400 }
        );
      }
      
      if (start > end) {
        return NextResponse.json(
          { error: 'Start date must be before or equal to end date.' },
          { status: 400 }
        );
      }
      
      dateRange = { start, end };
    }

    // Step 1: Get call logs from database
    console.log('📊 Step 1: Fetching call logs from database...');
    let logs = await getContactLogs(dateRange);
    console.log(`Found ${logs.length} call logs`);

    // Step 2: Check Supabase status
    console.log('🔍 Step 2: Checking Supabase for existing transcriptions...');
    logs = await enhanceCallLogsWithSupabaseStatus(logs);
    
    const missingTranscriptions = logs.filter(log => 
      !log.existsInSupabase && log.recording_location
    );
    console.log(`Found ${missingTranscriptions.length} calls without transcriptions`);

    let processedCount = 0;
    const errors: any[] = [];

    // Step 3: Process missing transcriptions (if requested)
    if (processTranscriptions && missingTranscriptions.length > 0) {
      console.log(`🎵 Step 3: Processing up to ${maxProcessCount} missing transcriptions...`);
      
      const apiKey = process.env.ASSEMBLYAI_API_KEY;
      if (!apiKey) {
        return NextResponse.json(
          { error: 'AssemblyAI API key not configured' },
          { status: 500 }
        );
      }

      const logsToProcess = missingTranscriptions.slice(0, maxProcessCount);
      
      for (const log of logsToProcess) {
        try {
          console.log(`\n🎯 Processing call ${log.contact_id}...`);
          
          // Download audio from SFTP
          console.log('📥 Downloading audio from SFTP...');
          const audioBuffer = await downloadAudioFromSftp(log.recording_location);
          
          // Upload to AssemblyAI
          console.log('⬆️ Uploading to AssemblyAI...');
          const uploadUrl = await uploadToAssemblyAI(audioBuffer, apiKey);
          
          // Transcribe audio
          console.log('🎙️ Transcribing audio...');
          const transcript = await transcribeAudio(uploadUrl, 2);
          
          // Perform topic categorization
          console.log('🏷️ Performing topic categorization...');
          let categorization: {
            primary_category: string;
            topic_categories: string[];
            confidence: number;
          } | null = null;
          
          if (transcript.utterances && transcript.utterances.length > 0) {
            try {
              categorization = await performTopicCategorization(transcript);
            } catch (catError) {
              console.error("⚠️ Categorization failed:", catError);
            }
            
            transcript.topic_categorization = categorization ? {
              primary_topic: categorization.primary_category,
              all_topics: categorization.topic_categories,
              confidence: categorization.confidence,
            } : {
              primary_topic: "Uncategorised",
              all_topics: ["Uncategorised"],
              confidence: 0,
            };
          }
          
          // Save to Supabase
          console.log('💾 Saving to Supabase...');
          await saveTranscriptionToSupabase(log, transcript, categorization);
          
          // Update log status
          log.existsInSupabase = true;
          processedCount++;
          
          console.log(`✅ Successfully processed call ${log.contact_id}`);
          
        } catch (error) {
          console.error(`❌ Error processing call ${log.contact_id}:`, error);
          errors.push({
            contact_id: log.contact_id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    }

    // Step 4: Return results
    console.log('📋 Step 4: Preparing response...');
    
    const summary = {
      totalCalls: logs.length,
      existingTranscriptions: logs.filter(log => log.existsInSupabase).length,
      missingTranscriptions: logs.filter(log => !log.existsInSupabase && log.recording_location).length,
      processedThisRequest: processedCount,
      errors: errors.length
    };

    console.log('🎉 Unified workflow completed:', summary);

    return NextResponse.json({
      success: true,
      data: logs,
      summary,
      errors: errors.length > 0 ? errors : undefined,
      dateRange: dateRange ? {
        start: dateRange.start.toISOString(),
        end: dateRange.end.toISOString()
      } : null,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('💥 Unified workflow error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to process calls',
        details: process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : undefined
      },
      { status: 500 }
    );
  }
}

// POST endpoint for processing specific calls
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { contactIds, processTranscriptions = true } = body;

    if (!contactIds || !Array.isArray(contactIds)) {
      return NextResponse.json(
        { error: 'contactIds array is required' },
        { status: 400 }
      );
    }

    console.log(`🚀 Processing specific calls: ${contactIds.join(', ')}`);

    // Get specific call logs
    const logs = await getContactLogs();
    const targetLogs = logs.filter(log => contactIds.includes(log.contact_id));
    
    if (targetLogs.length === 0) {
      return NextResponse.json(
        { error: 'No matching call logs found' },
        { status: 404 }
      );
    }

    // Check Supabase status
    const enhancedLogs = await enhanceCallLogsWithSupabaseStatus(targetLogs);
    const missingTranscriptions = enhancedLogs.filter(log => 
      !log.existsInSupabase && log.recording_location
    );

    let processedCount = 0;
    const errors: any[] = [];

    if (processTranscriptions && missingTranscriptions.length > 0) {
      const apiKey = process.env.ASSEMBLYAI_API_KEY;
      if (!apiKey) {
        return NextResponse.json(
          { error: 'AssemblyAI API key not configured' },
          { status: 500 }
        );
      }

      for (const log of missingTranscriptions) {
        try {
          console.log(`🎯 Processing call ${log.contact_id}...`);
          
          const audioBuffer = await downloadAudioFromSftp(log.recording_location);
          const uploadUrl = await uploadToAssemblyAI(audioBuffer, apiKey);
          const transcript = await transcribeAudio(uploadUrl, 2);
          
          let categorization = null;
          if (transcript.utterances && transcript.utterances.length > 0) {
            try {
              categorization = await performTopicCategorization(transcript);
            } catch (catError) {
              console.error("Categorization failed:", catError);
            }
            
            transcript.topic_categorization = categorization ? {
              primary_topic: categorization.primary_category,
              all_topics: categorization.topic_categories,
              confidence: categorization.confidence,
            } : {
              primary_topic: "Uncategorised",
              all_topics: ["Uncategorised"],
              confidence: 0,
            };
          }
          
          await saveTranscriptionToSupabase(log, transcript, categorization);
          log.existsInSupabase = true;
          processedCount++;
          
          console.log(`✅ Successfully processed call ${log.contact_id}`);
          
        } catch (error) {
          console.error(`❌ Error processing call ${log.contact_id}:`, error);
          errors.push({
            contact_id: log.contact_id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: enhancedLogs,
      summary: {
        requestedCalls: contactIds.length,
        foundCalls: targetLogs.length,
        existingTranscriptions: enhancedLogs.filter(log => log.existsInSupabase).length,
        processedThisRequest: processedCount,
        errors: errors.length
      },
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error in POST workflow:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to process specific calls',
        details: process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : undefined
      },
      { status: 500 }
    );
  }
}