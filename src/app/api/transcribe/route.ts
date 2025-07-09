/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

/**
 * Helper function to save transcription to Supabase
 */
async function saveToSupabase(
  callData: any,
  transcriptData: any,
  categorization: any = null
) {
  try {
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://192.168.40.101:3000";

    const payload = {
      contact_id: callData.contact_id,
      recording_location: callData.recording_location || "",
      transcript_text: transcriptData.text || "",
      queue_name: callData.queue_name || null,
      agent_username: callData.agent_username || "",
      initiation_timestamp: callData.initiation_timestamp || new Date().toISOString(),
      speaker_data: transcriptData.utterances ? JSON.stringify(transcriptData.utterances) : null,
      sentiment_analysis: transcriptData.sentiment_analysis_results ? JSON.stringify(transcriptData.sentiment_analysis_results) : null,
      entities: transcriptData.entities ? JSON.stringify(transcriptData.entities) : null,
      disposition_title: callData.disposition_title || null,
      call_summary: transcriptData.summary || null,
      campaign_name: callData.campaign_name || null,
      campaign_id: callData.campaign_id || null,
      customer_cli: callData.customer_cli || null,
      agent_hold_time: callData.agent_hold_time || null,
      total_hold_time: callData.total_hold_time || null,
      time_in_queue: callData.time_in_queue || null,
      call_duration: callData.total_call_time || null,
      categories: categorization?.topic_categories 
        ? JSON.stringify(categorization.topic_categories) 
        : (transcriptData.topic_categorization?.all_topics ? JSON.stringify(transcriptData.topic_categorization.all_topics) : null),
      primary_category: categorization?.primary_category || transcriptData.topic_categorization?.primary_topic || null,
    };

    const response = await fetch(`${serverUrl}/api/supabase/save-transcription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase save failed: ${response.status}`);
    }

    const result = await response.json();
    return result.data;
  } catch (error) {
    console.error("Error saving to Supabase:", error);
    throw error;
  }
}

/**
 * Get server URL with proper network configuration
 */
function getServerUrl(): string {
  const possibleUrls = [
    process.env.NEXT_PUBLIC_SERVER_URL,
    process.env.NETWORK_URL,
    'http://192.168.40.101:3000'
  ].filter(Boolean) as string[];
  
  return possibleUrls[0] || 'http://192.168.40.101:3000';
}

/**
 * OPTIMIZED: Efficient chunked download with retry logic for small files
 */
async function downloadAudioWithChunking(sftpFilename: string): Promise<Blob> {
  console.log("🔽 Starting efficient chunked download for:", sftpFilename);
  
  const serverUrl = getServerUrl();
  const decodedFilename = decodeURIComponent(sftpFilename);
  const downloadUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
  
  console.log("📡 Download URL:", downloadUrl);

  // Retry configuration for small files
  const maxRetries = 3;
  const retryDelays = [1000, 2000, 5000]; // 1s, 2s, 5s
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`📥 Download attempt ${attempt + 1}/${maxRetries}`);
      
      // Shorter timeout for small files (30 seconds should be plenty)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(downloadUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'TranscriptionService/1.0',
          'Accept': 'audio/*,*/*',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} - ${response.statusText}`);
      }

      // Check content length
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const sizeInMB = parseInt(contentLength) / (1024 * 1024);
        console.log(`📊 File size: ${sizeInMB.toFixed(2)}MB`);
        
        if (sizeInMB > 50) { // Sanity check for "small" files
          console.warn(`⚠️ File larger than expected: ${sizeInMB.toFixed(2)}MB`);
        }
      }

      // Read the response as a blob (most efficient for binary data)
      const audioBlob = await response.blob();
      
      console.log(`✅ Downloaded successfully: ${audioBlob.size} bytes, type: ${audioBlob.type}`);
      
      // Validate the downloaded blob
      if (audioBlob.size === 0) {
        throw new Error("Downloaded file is empty");
      }
      
      if (audioBlob.size < 1000) { // Less than 1KB is suspicious for audio
        throw new Error(`Downloaded file too small: ${audioBlob.size} bytes`);
      }

      return audioBlob;

    } catch (error) {
      console.error(`❌ Download attempt ${attempt + 1} failed:`, error);
      
      if (attempt === maxRetries - 1) {
        // Last attempt failed
        throw new Error(`Download failed after ${maxRetries} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      
      // Wait before retry
      const delay = retryDelays[attempt];
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error("Download failed - should not reach here");
}

/**
 * OPTIMIZED: Fast upload to AssemblyAI with proper blob handling
 */
async function uploadToAssemblyAI(audioBlob: Blob, apiKey: string, originalFilename?: string): Promise<string> {
  console.log("⬆️ Uploading to AssemblyAI:", {
    size: audioBlob.size,
    sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2),
    type: audioBlob.type,
    originalFilename
  });

  // Prepare filename
  let filename = 'audio.wav';
  if (originalFilename) {
    const decodedFilename = decodeURIComponent(originalFilename);
    filename = decodedFilename.split('/').pop() || 'audio.wav';
    
    // Ensure proper audio extension
    if (!filename.match(/\.(wav|mp3|flac|m4a|aac|ogg)$/i)) {
      filename = filename.replace(/\.[^.]*$/, '') + '.wav';
    }
  }

  // Create form data with optimized blob
  const formData = new FormData();
  
  // Ensure proper MIME type for audio recognition
  const optimizedBlob = new Blob([audioBlob], { 
    type: audioBlob.type || 'audio/wav' 
  });
  
  formData.append("file", optimizedBlob, filename);

  // Reasonable timeout for small files (2 minutes max)
  const timeout = 120000; // 2 minutes should be plenty for small files

  console.log(`⏰ Upload timeout set to ${timeout / 1000} seconds`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        Authorization: apiKey,
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      console.error("❌ AssemblyAI upload error:", errorData);
      throw new Error(`AssemblyAI upload failed: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
    }

    const uploadData = await uploadResponse.json();
    console.log("✅ Upload successful:", uploadData.upload_url);
    
    return uploadData.upload_url;
    
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Upload timed out after ${timeout / 1000} seconds`);
    }
    
    throw error;
  }
}

/**
 * OPTIMIZED: Try direct URL first, then efficient download strategy
 */
async function getOptimizedAudioUrl(sftpFilename: string, apiKey: string): Promise<string> {
  console.log("🎯 Starting optimized audio URL resolution for:", sftpFilename);
  
  const serverUrl = getServerUrl();
  const decodedFilename = decodeURIComponent(sftpFilename);
  const directUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
  
  // STEP 1: Quick direct URL test (10 second timeout)
  try {
    console.log("🚀 Testing direct URL approach...");
    
    const headResponse = await fetch(directUrl, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(10000)
    });
    
    if (headResponse.ok) {
      const contentLength = headResponse.headers.get('content-length');
      const sizeInMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0;
      
      console.log(`✅ Direct URL verified! File: ${sizeInMB.toFixed(2)}MB`);
      console.log(`🎯 Using direct URL: ${directUrl}`);
      
      return directUrl;
    }
  } catch (directError) {
    console.log(`❌ Direct URL failed: ${directError instanceof Error ? directError.message : 'Unknown'}`);
  }
  
  // STEP 2: Download and upload approach
  console.log("🔄 Using download+upload approach...");
  
  const audioBlob = await downloadAudioWithChunking(sftpFilename);
  const uploadUrl = await uploadToAssemblyAI(audioBlob, apiKey, sftpFilename);
  
  return uploadUrl;
}

/**
 * Topic categorization with shorter timeout
 */
async function performTopicCategorization(transcriptData: any) {
  try {
    const serverUrl = getServerUrl();

    const response = await fetch(`${serverUrl}/api/openAI/categorise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcriptData }),
      signal: AbortSignal.timeout(20000), // 20 seconds for categorization
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

export async function POST(request: Request) {
  const requestStartTime = Date.now();
  // Shorter timeout for small files - 3 minutes should be plenty
  const MAX_REQUEST_TIME = 3 * 60 * 1000; 
  
  try {
    const body = await request.json();
    const {
      audioUrl,
      speakerCount = 2,
      filename,
      isDirectSftpFile = false,
      sftpFilename = null,
      callData = null,
    } = body;

    console.log("🎬 TRANSCRIPTION REQUEST START:", {
      filename,
      isDirectSftpFile,
      sftpFilename,
      callId: callData?.contact_id
    });

    // Validation
    if (!audioUrl && !isDirectSftpFile) {
      return NextResponse.json({ error: "Audio source required" }, { status: 400 });
    }

    if (!filename) {
      return NextResponse.json({ error: "Filename required" }, { status: 400 });
    }

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "AssemblyAI API key not configured" }, { status: 500 });
    }

    let uploadUrl: string;

    // PHASE 1: Get audio URL efficiently
    try {
      console.log("📁 PHASE 1: Audio processing...");
      
      if (isDirectSftpFile && sftpFilename) {
        uploadUrl = await getOptimizedAudioUrl(sftpFilename, apiKey);
      } else if (audioUrl) {
        console.log("Using provided audio URL:", audioUrl);
        uploadUrl = audioUrl;
      } else {
        throw new Error("No valid audio source");
      }

      console.log(`✅ Audio URL ready: ${uploadUrl.substring(0, 100)}...`);

    } catch (audioError) {
      console.error("❌ Audio processing failed:", audioError);
      
      return NextResponse.json({
        error: "Failed to process audio file",
        details: audioError instanceof Error ? audioError.message : "Unknown error",
        stage: "audio_processing"
      }, { status: 500 });
    }

    // PHASE 2: Submit to AssemblyAI
    console.log("📡 PHASE 2: Submitting to AssemblyAI...");
    
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
        speakers_expected: speakerCount || 2,
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
      signal: AbortSignal.timeout(15000), // 15 seconds for submission
    });

    if (!transcriptResponse.ok) {
      const errorData = await transcriptResponse.json();
      console.error("AssemblyAI submission failed:", errorData);
      return NextResponse.json({
        error: "Failed to initiate transcription",
        details: errorData
      }, { status: 500 });
    }

    const { id } = await transcriptResponse.json();
    console.log(`✅ Transcription job created: ${id}`);

    // PHASE 3: Poll for results (shorter polling for small files)
    console.log("⏳ PHASE 3: Polling for results...");
    
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 90; // 3 minutes at 2-second intervals
    const pollInterval = 2000;

    while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
      const elapsed = Date.now() - requestStartTime;
      
      if (elapsed > MAX_REQUEST_TIME - 30000) {
        console.log("⏰ Approaching timeout, stopping poll");
        break;
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
      attempts++;

      try {
        const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
          headers: { Authorization: apiKey },
          signal: AbortSignal.timeout(10000),
        });

        if (!statusResponse.ok) {
          console.error("Status check failed:", statusResponse.status);
          continue;
        }

        transcript = await statusResponse.json();
        status = transcript.status;
        
        // Log progress every 15 attempts (30 seconds)
        if (attempts % 15 === 0) {
          console.log(`📊 Status: ${status}, attempt: ${attempts}/${maxAttempts}, elapsed: ${Math.round(elapsed/1000)}s`);
        }
        
      } catch (statusError) {
        console.error("Status check error:", statusError);
        if (attempts >= maxAttempts - 5) break;
      }
    }

    // PHASE 4: Process results
    if (status === "completed" && transcript) {
      console.log("✅ Transcription completed!");

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

      // Optional topic categorization
      let categorization = null;
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

      // Optional Supabase save
      if (callData) {
        try {
          await saveToSupabase(callData, transcript, categorization);
          console.log("✅ Saved to Supabase");
        } catch (supabaseError) {
          console.error("⚠️ Supabase save failed:", supabaseError);
        }
      }

      const totalTime = Date.now() - requestStartTime;
      console.log(`🎉 TRANSCRIPTION COMPLETE in ${Math.round(totalTime/1000)}s`);

      return NextResponse.json({
        ...transcript,
        status: "completed",
        call_data: callData || null,
      });

    } else if (status === "error") {
      console.error("❌ AssemblyAI error:", transcript?.error);
      return NextResponse.json({
        error: `Transcription failed: ${transcript?.error || "Unknown error"}`,
        status: "error",
      }, { status: 500 });
      
    } else {
      console.error("⏰ Transcription timed out");
      return NextResponse.json({
        error: "Transcription timed out. Please try again.",
        status: "timeout",
        transcription_id: id,
      }, { status: 504 });
    }

  } catch (error) {
    console.error("💥 TRANSCRIPTION FAILED:", error);
    return NextResponse.json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown Error",
      status: "error"
    }, { status: 500 });
  }
}