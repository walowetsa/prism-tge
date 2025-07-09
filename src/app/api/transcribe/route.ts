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
 * FIXED: NO TIMEOUTS - download with basic retry logic for call recordings
 */
async function downloadAudioWithChunking(sftpFilename: string): Promise<Blob> {
  console.log("🔽 Starting call recording download (NO TIMEOUTS):", sftpFilename);
  
  const serverUrl = getServerUrl();
  const decodedFilename = decodeURIComponent(sftpFilename);
  const downloadUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
  
  console.log("📡 Download URL:", downloadUrl);

  // Simple retry without timeouts
  const maxRetries = 2;
  const retryDelays = [2000, 5000]; // 2s, 5s
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`📥 Download attempt ${attempt + 1}/${maxRetries} (NO TIMEOUT)`);
      
      // NO TIMEOUT on fetch
      const response = await fetch(downloadUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'TranscriptionService/1.0',
          'Accept': 'audio/*,*/*',
          'Cache-Control': 'no-cache',
        },
        // NO SIGNAL/TIMEOUT
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} - ${response.statusText}`);
      }

      // Check content length
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const sizeInMB = parseInt(contentLength) / (1024 * 1024);
        console.log(`📊 Call recording size: ${sizeInMB.toFixed(2)}MB (NO TIMEOUT LIMITS)`);
      }

      // Read the response as a blob - NO TIMEOUT
      const audioBlob = await response.blob();
      
      console.log(`✅ Downloaded successfully: ${audioBlob.size} bytes, type: ${audioBlob.type}`);
      
      // Validate the downloaded blob
      if (audioBlob.size === 0) {
        throw new Error("Downloaded file is empty");
      }
      
      if (audioBlob.size < 10000) {
        throw new Error(`Downloaded file too small for a call recording: ${audioBlob.size} bytes`);
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
 * FIXED: Upload to AssemblyAI with NO TIMEOUT
 */
async function uploadToAssemblyAI(audioBlob: Blob, apiKey: string, originalFilename?: string): Promise<string> {
  console.log("⬆️ Uploading to AssemblyAI (NO TIMEOUT):", {
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

  console.log(`⏰ NO TIMEOUT SET - will wait as long as needed`);

  try {
    const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        Authorization: apiKey,
      },
      body: formData,
      // NO SIGNAL/TIMEOUT
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      console.error("❌ AssemblyAI upload error:", errorData);
      throw new Error(`AssemblyAI upload failed: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
    }

    const uploadData = await uploadResponse.json();
    console.log("✅ Upload successful:", uploadData.upload_url);
    
    return uploadData.upload_url;
    
  } catch (error) {
    throw error;
  }
}

/**
 * FIXED: Try direct URL first with NO TIMEOUT, then download approach
 */
async function getOptimizedAudioUrl(sftpFilename: string, apiKey: string): Promise<string> {
  console.log("🎯 Starting optimized audio URL resolution (NO TIMEOUTS):", sftpFilename);
  
  const serverUrl = getServerUrl();
  const decodedFilename = decodeURIComponent(sftpFilename);
  const directUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
  
  // STEP 1: Quick direct URL test (NO TIMEOUT)
  try {
    console.log("🚀 Testing direct URL approach (NO TIMEOUT)...");
    
    const headResponse = await fetch(directUrl, { 
      method: 'HEAD',
      // NO TIMEOUT
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
  
  // STEP 2: Download and upload approach (NO TIMEOUTS)
  console.log("🔄 Using download+upload approach (NO TIMEOUTS)...");
  
  const audioBlob = await downloadAudioWithChunking(sftpFilename);
  const uploadUrl = await uploadToAssemblyAI(audioBlob, apiKey, sftpFilename);
  
  return uploadUrl;
}

/**
 * Topic categorization with NO TIMEOUT
 */
async function performTopicCategorization(transcriptData: any) {
  try {
    const serverUrl = getServerUrl();

    const response = await fetch(`${serverUrl}/api/openAI/categorise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcriptData }),
      // NO TIMEOUT
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
  // REMOVED: NO timeout limits - let it run as long as needed
  
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

    console.log("🎬 CALL RECORDING TRANSCRIPTION START (NO TIMEOUTS):", {
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

    // PHASE 1: Get audio URL efficiently (NO TIMEOUTS)
    try {
      console.log("📁 PHASE 1: Audio processing (NO TIMEOUTS)...");
      
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

    // PHASE 2: Submit to AssemblyAI (NO TIMEOUT)
    console.log("📡 PHASE 2: Submitting to AssemblyAI (NO TIMEOUT)...");
    
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
      // NO TIMEOUT
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

    // PHASE 3: Poll for results (NO TIMEOUT LIMITS)
    console.log("⏳ PHASE 3: Polling for results (NO TIMEOUT LIMITS)...");
    
    let transcript;
    let status = "processing";
    let attempts = 0;
    const pollInterval = 5000; // 5 seconds between polls

    while (status === "processing" || status === "queued") {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      attempts++;

      try {
        const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
          headers: { Authorization: apiKey },
          // NO TIMEOUT
        });

        if (!statusResponse.ok) {
          console.error("Status check failed:", statusResponse.status);
          continue;
        }

        transcript = await statusResponse.json();
        status = transcript.status;
        
        // Log progress every 12 attempts (60 seconds)
        if (attempts % 12 === 0) {
          const elapsed = Date.now() - requestStartTime;
          console.log(`📊 Status: ${status}, attempt: ${attempts}, elapsed: ${Math.round(elapsed/1000)}s (NO TIMEOUT LIMITS)`);
        }
        
      } catch (statusError) {
        console.error("Status check error:", statusError);
        // Continue polling even on errors
      }
    }

    // PHASE 4: Process results (NO TIMEOUT LIMITS)
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

      // Optional topic categorization (NO TIMEOUT)
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
      console.log(`🎉 TRANSCRIPTION COMPLETE in ${Math.round(totalTime/1000)}s (NO TIMEOUT LIMITS)`);

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
      // This should only happen if AssemblyAI never responds or has issues
      const totalTime = Date.now() - requestStartTime;
      console.error(`⚠️ Transcription incomplete after ${Math.round(totalTime/1000)}s, final status: ${status}`);
      
      return NextResponse.json({
        error: "Transcription did not complete. This may indicate an issue with AssemblyAI service.",
        status: status || "unknown",
        transcription_id: id,
        elapsed_time: Math.round(totalTime/1000),
      }, { status: 500 });
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