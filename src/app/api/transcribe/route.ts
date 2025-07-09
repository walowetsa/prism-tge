/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

/**
 * Helper function to save transcription to Supabase
 */
async function saveToSupabase(
  callId: string,
  transcriptData: any,
  transcriptText: string
) {
  try {
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
    const apiUrl = `${serverUrl}/api/supabase/save-transcription`;

    console.log(`💾 Saving transcription to Supabase for call ID: ${callId}`);

    const payload = {
      contact_id: callId,
      recording_location: transcriptData.recording_location || "",
      transcript_text: transcriptText,
      queue_name: transcriptData.queue_name || null,
      agent_username: transcriptData.agent_username || "",
      initiation_timestamp: transcriptData.initiation_timestamp || new Date().toISOString(),
      speaker_data: transcriptData.utterances ? JSON.stringify(transcriptData.utterances) : null,
      sentiment_analysis: transcriptData.sentiment_analysis_results ? JSON.stringify(transcriptData.sentiment_analysis_results) : null,
      entities: transcriptData.entities ? JSON.stringify(transcriptData.entities) : null,
      disposition_title: transcriptData.disposition_title || null,
      call_summary: transcriptData.summary || null,
      campaign_name: transcriptData.campaign_name || null,
      campaign_id: transcriptData.campaign_id || null,
      customer_cli: transcriptData.customer_cli || null,
      agent_hold_time: transcriptData.agent_hold_time || null,
      total_hold_time: transcriptData.total_hold_time || null,
      time_in_queue: transcriptData.time_in_queue || null,
      call_duration: transcriptData.call_duration || null,
      categories: transcriptData.topic_categorization?.all_topics ? JSON.stringify(transcriptData.topic_categorization.all_topics) : null,
      primary_category: transcriptData.topic_categorization?.primary_topic || null,
    };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Supabase save failed for ${callId}:`, errorText);
      throw new Error(`Supabase save failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`✅ Successfully saved to Supabase:`, result.data?.contact_id);
    return result.data;
  } catch (error) {
    console.error("❌ Error saving to Supabase:", error);
    return null;
  }
}

/**
 * Helper function to download a file from SFTP with improved error handling
 */
async function getSftpAudio(sftpFilename: string) {
  console.log("🔄 Downloading SFTP file:", sftpFilename);

  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
  const sftpApiUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(sftpFilename)}`;

  console.log("📡 SFTP API URL:", sftpApiUrl);

  try {
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const audioResponse = await fetch(sftpApiUrl, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`📡 SFTP Response Status: ${audioResponse.status}`);
    console.log(`📡 SFTP Response Headers:`, Object.fromEntries(audioResponse.headers.entries()));

    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      console.error("❌ SFTP download failed:", errorText);
      throw new Error(`SFTP download failed: ${audioResponse.status} - ${errorText}`);
    }

    const audioBlob = await audioResponse.blob();
    console.log(`📁 Audio blob size: ${audioBlob.size} bytes`);
    console.log(`📁 Audio blob type: ${audioBlob.type}`);

    if (audioBlob.size === 0) {
      throw new Error("Retrieved audio file is empty");
    }

    if (audioBlob.size < 1000) { // Less than 1KB is probably not a valid audio file
      console.warn("⚠️ Audio file seems very small, might be corrupted");
    }

    return audioBlob;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error("SFTP download timed out after 30 seconds");
      }
      throw new Error(`SFTP download error: ${error.message}`);
    }
    throw new Error("Unknown SFTP download error");
  }
}

/**
 * Helper function to upload audio to AssemblyAI with improved error handling
 */
async function uploadToAssemblyAI(audioBlob: Blob, apiKey: string) {
  console.log("⬆️ Uploading to AssemblyAI...");
  console.log(`📁 Upload blob size: ${audioBlob.size} bytes, type: ${audioBlob.type}`);

  try {
    const uploadFormData = new FormData();
    uploadFormData.append("file", audioBlob, "audio.wav");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout for upload

    const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        Authorization: apiKey,
      },
      body: uploadFormData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`⬆️ AssemblyAI Upload Status: ${uploadResponse.status}`);

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      console.error("❌ AssemblyAI upload error:", errorData);
      throw new Error(`AssemblyAI upload failed: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
    }

    const uploadData = await uploadResponse.json();
    console.log("✅ Upload successful. Upload URL:", uploadData.upload_url);
    return uploadData.upload_url;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error("AssemblyAI upload timed out after 60 seconds");
      }
      throw new Error(`AssemblyAI upload error: ${error.message}`);
    }
    throw new Error("Unknown AssemblyAI upload error");
  }
}

export async function POST(request: Request) {
  console.log("🎯 Transcribe API called");
  
  try {
    const body = await request.json();
    console.log("📝 Request body:", {
      hasAudioUrl: !!body.audioUrl,
      isDirectSftpFile: body.isDirectSftpFile,
      sftpFilename: body.sftpFilename,
      filename: body.filename,
      speakerCount: body.speakerCount
    });

    const {
      audioUrl,
      speakerCount = 2,
      filename,
      isDirectSftpFile = false,
      sftpFilename = null,
    } = body;

    // Validation
    if (!audioUrl && !isDirectSftpFile) {
      return NextResponse.json(
        { error: "Either Audio URL or SFTP filename is required" },
        { status: 400 }
      );
    }

    if (!filename) {
      return NextResponse.json(
        { error: "Filename is required for caching" },
        { status: 400 }
      );
    }

    // Check API key
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      console.error("❌ AssemblyAI API key not configured");
      return NextResponse.json(
        { error: "AssemblyAI API key is not configured" },
        { status: 500 }
      );
    }
    console.log("🔑 AssemblyAI API key found");

    let fileToTranscribe: string;

    try {
      if (isDirectSftpFile && sftpFilename) {
        console.log("🔄 Processing SFTP file:", sftpFilename);
        
        // Get audio from SFTP
        const audioBlob = await getSftpAudio(sftpFilename);
        console.log("✅ SFTP download successful");
        
        // Upload to AssemblyAI
        fileToTranscribe = await uploadToAssemblyAI(audioBlob, apiKey);
        console.log("✅ AssemblyAI upload successful");
      } else if (audioUrl) {
        console.log("🔄 Processing audio URL:", audioUrl);
        // For URL-based audio, you'd implement similar logic here
        fileToTranscribe = audioUrl;
      } else {
        throw new Error("No valid audio source provided");
      }
    } catch (error) {
      console.error("❌ Error processing audio:", error);
      return NextResponse.json(
        { 
          error: error instanceof Error ? error.message : "Error processing audio file",
          details: "Failed during audio acquisition or upload phase"
        },
        { status: 500 }
      );
    }

    console.log("🎤 Submitting transcription request to AssemblyAI with file:", fileToTranscribe);

    // Submit the transcription request to AssemblyAI
    const transcriptRequestBody = {
      audio_url: fileToTranscribe,
      speech_model: "slam-1",
      keyterms_prompt: [
        "mycar", "tyre", "auto", "rego", "speaking", "you're", "Pirelli",
        "end", "of", "financial", "year", "sale", "care", "plan",
        "end of financial year sale", "tyre care plan", "quote", "email",
      ],
      speaker_labels: true,
      speakers_expected: speakerCount || 2,
      summarization: true,
      summary_model: "conversational",
      summary_type: "paragraph",
      entity_detection: true,
      sentiment_analysis: true,
    };

    console.log("📋 Transcription request config:", {
      speakers_expected: transcriptRequestBody.speakers_expected,
      speech_model: transcriptRequestBody.speech_model,
      keyterms_count: transcriptRequestBody.keyterms_prompt.length
    });

    const transcriptResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transcriptRequestBody),
    });

    console.log(`📡 AssemblyAI Transcript Request Status: ${transcriptResponse.status}`);

    if (!transcriptResponse.ok) {
      const errorData = await transcriptResponse.json();
      console.error("❌ Transcription request error:", errorData);
      return NextResponse.json(
        { error: "Failed to initiate transcription", details: errorData },
        { status: 500 }
      );
    }

    const { id } = await transcriptResponse.json();
    console.log(`🆔 Transcription job created with ID: ${id}`);

    // Poll for the transcription result
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 120; // Increased to 120 (2 minutes)

    console.log("⏳ Starting polling for transcription result...");

    while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;

      if (attempts % 10 === 0) { // Log every 10 attempts
        console.log(`⏳ Polling attempt ${attempts}/${maxAttempts}, status: ${status}`);
      }

      const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { Authorization: apiKey },
      });

      if (!statusResponse.ok) {
        const errorData = await statusResponse.json();
        console.error("❌ Status check error:", errorData);
        return NextResponse.json(
          { error: "Failed to check transcription status", details: errorData },
          { status: 500 }
        );
      }

      transcript = await statusResponse.json();
      status = transcript.status;
    }

    console.log(`🏁 Final transcription status: ${status} after ${attempts} attempts`);

    if (status === "completed") {
      console.log("✅ Transcription completed successfully");
      console.log(`📝 Transcript length: ${transcript.text?.length || 0} characters`);
      console.log(`🗣️ Utterances count: ${transcript.utterances?.length || 0}`);

      // Map speaker labels to Agent and Customer
      if (transcript.utterances && transcript.utterances.length > 0) {
        transcript.utterances = transcript.utterances.map((utterance: { speaker: string }) => ({
          ...utterance,
          speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      if (transcript.words && transcript.words.length > 0) {
        transcript.words = transcript.words.map((word: { speaker: string }) => ({
          ...word,
          speakerRole: word.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      // Call topic categorization endpoint
      try {
        console.log("🏷️ Starting topic categorization...");
        const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

        const topicResponse = await fetch(`${serverUrl}/api/openAI/categorise`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });

        if (topicResponse.ok) {
          const topicData = await topicResponse.json();
          console.log("✅ Topic categorization completed:", topicData);

          if (topicData.topic_categories && topicData.topic_categories.length > 0) {
            transcript.topic_categorization = {
              primary_topic: topicData.primary_category,
              all_topics: topicData.topic_categories,
              confidence: topicData.confidence || 1.0,
            };
            console.log("🏷️ Added topic categorization to transcript");
          } else {
            console.warn("⚠️ Invalid categorization data received");
            transcript.topic_categorization = {
              primary_topic: "Uncategorised",
              all_topics: ["Uncategorised"],
              confidence: 0,
            };
          }
        } else {
          const errorText = await topicResponse.text();
          console.error("❌ Topic categorization failed:", topicResponse.status, errorText);
          transcript.topic_categorization = {
            primary_topic: "Uncategorised",
            all_topics: ["Uncategorised"],
            confidence: 0,
          };
        }
      } catch (topicError) {
        console.error("❌ Error in topic categorization:", topicError);
        transcript.topic_categorization = {
          primary_topic: "Uncategorised",
          all_topics: ["Uncategorised"],
          confidence: 0,
        };
      }

      // Save to Supabase
      try {
        const callId = filename.replace(/\.[^/.]+$/, "");
        const transcriptText = transcript.text || "";
        console.log("💾 Attempting to save to Supabase...");
        await saveToSupabase(callId, transcript, transcriptText);
      } catch (supabaseError) {
        console.error("❌ Supabase save failed (continuing anyway):", supabaseError);
      }

      console.log("🎉 Transcription process completed successfully");
      return NextResponse.json(transcript);

    } else if (attempts >= maxAttempts) {
      console.error("⏰ Transcription timed out");
      return NextResponse.json(
        { error: "Transcription timed out. The file might be too large or the service is busy." },
        { status: 504 }
      );
    } else {
      console.error(`❌ Transcription failed with status: ${status}`);
      return NextResponse.json(
        {
          error: `Transcription failed with status: ${status}`,
          details: transcript?.error || "Unknown error",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("💥 Unexpected error in transcribe API route:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        message: error instanceof Error ? error.message : "Unknown Error",
        stack: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}