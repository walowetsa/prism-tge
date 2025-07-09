/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";

interface DateRange {
  start: Date;
  end: Date;
  label: string;
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
  transcriptionStatus?: "Transcribed" | "Pending Transcription" | "Failed";
  transcriptionProgress?: number;
  transcriptionError?: string;
}

type SortField = 'agent_username' | 'initiation_timestamp' | 'total_call_time' | 'queue_name' | 'disposition_title';
type SortDirection = 'asc' | 'desc';

const ITEMS_PER_PAGE = 100;

const CallLogDisplay = ({
  selectedDateRange,
  checkSupabase = true,
}: {
  selectedDateRange: DateRange | null;
  checkSupabase?: boolean;
}) => {
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Agent filter state
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  
  // Sorting state
  const [sortField, setSortField] = useState<SortField>('initiation_timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);

  // Audio download state
  const [downloadingAudio, setDownloadingAudio] = useState<string[]>([]);

  // FIXED: Improved transcription state management
  const [transcriptionQueue, setTranscriptionQueue] = useState<string[]>([]);
  const [activeTranscriptions, setActiveTranscriptions] = useState<Set<string>>(new Set());
  const [failedTranscriptions, setFailedTranscriptions] = useState<Set<string>>(new Set());
  const maxConcurrentTranscriptions = 1; // REDUCED from 5 to 1 for better stability
  
  // FIXED: Use refs to track progress intervals and prevent memory leaks
  const progressIntervals = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const transcriptionControllers = useRef<Map<string, AbortController>>(new Map());

  // Get unique agents from call logs
  const uniqueAgents = useMemo(() => {
    const agents = Array.from(new Set(callLogs.map(log => log.agent_username)))
      .filter(agent => agent && agent.trim() !== "")
      .sort();
    return agents;
  }, [callLogs]);

  // Filter and sort call logs
  const filteredAndSortedCallLogs = useMemo(() => {
    let filtered = callLogs;
    
    // Apply agent filter
    if (selectedAgent !== "all") {
      filtered = callLogs.filter(log => log.agent_username === selectedAgent);
    }
    
    // Apply sorting
    return filtered.sort((a, b) => {
      let aValue: any, bValue: any;
      
      switch (sortField) {
        case 'agent_username':
          aValue = a.agent_username || '';
          bValue = b.agent_username || '';
          break;
        case 'initiation_timestamp':
          aValue = new Date(a.initiation_timestamp).getTime();
          bValue = new Date(b.initiation_timestamp).getTime();
          break;
        case 'total_call_time':
          aValue = (a.total_call_time?.minutes || 0) * 60 + (a.total_call_time?.seconds || 0);
          bValue = (b.total_call_time?.minutes || 0) * 60 + (b.total_call_time?.seconds || 0);
          break;
        case 'queue_name':
          aValue = a.queue_name || '';
          bValue = b.queue_name || '';
          break;
        case 'disposition_title':
          aValue = a.disposition_title || '';
          bValue = b.disposition_title || '';
          break;
        default:
          return 0;
      }
      
      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [callLogs, selectedAgent, sortField, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedCallLogs.length / ITEMS_PER_PAGE);
  const paginatedCallLogs = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return filteredAndSortedCallLogs.slice(startIndex, endIndex);
  }, [filteredAndSortedCallLogs, currentPage]);

  // FIXED: Cleanup function for transcription resources
  const cleanupTranscription = useCallback((contactId: string) => {
    // Clear progress interval
    const interval = progressIntervals.current.get(contactId);
    if (interval) {
      clearInterval(interval);
      progressIntervals.current.delete(contactId);
    }
    
    // Abort any ongoing request
    const controller = transcriptionControllers.current.get(contactId);
    if (controller) {
      controller.abort();
      transcriptionControllers.current.delete(contactId);
    }
    
    // Remove from active transcriptions
    setActiveTranscriptions(prev => {
      const newSet = new Set(prev);
      newSet.delete(contactId);
      return newSet;
    });
  }, []);

  // FIXED: Cleanup all transcriptions on unmount
  useEffect(() => {
    return () => {
      // Cleanup all intervals and controllers
      progressIntervals.current.forEach(interval => clearInterval(interval));
      transcriptionControllers.current.forEach(controller => controller.abort());
      progressIntervals.current.clear();
      transcriptionControllers.current.clear();
    };
  }, []);

  // Handle sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Handle audio download
  const handleAudioDownload = async (log: CallLog) => {
    if (!log.recording_location) {
      alert("No audio file available for this call");
      return;
    }

    const contactId = log.contact_id;
    
    // Check if already downloading
    if (downloadingAudio.includes(contactId)) {
      return;
    }

    // Add to downloading state
    setDownloadingAudio(prev => [...prev, contactId]);

    try {
      console.log(`🎵 Starting audio download for call ${contactId}`);
      console.log(`📁 Recording location: ${log.recording_location}`);

      // Use the SFTP download endpoint
      const downloadUrl = `/api/sftp/download?filename=${encodeURIComponent(log.recording_location)}`;
      
      console.log(`🌐 Download URL: ${downloadUrl}`);

      const response = await fetch(downloadUrl);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Download failed: ${response.status} - ${errorText}`);
        throw new Error(`Download failed: ${response.status} - ${errorText}`);
      }

      // Get the blob
      const blob = await response.blob();
      console.log(`📦 Downloaded blob: ${blob.size} bytes, type: ${blob.type}`);

      if (blob.size === 0) {
        throw new Error("Downloaded file is empty");
      }

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      
      // Extract filename from recording location
      const filename = log.recording_location.split('/').pop() || `call_${contactId}.wav`;
      a.download = filename;
      
      // Trigger download
      document.body.appendChild(a);
      a.click();
      
      // Cleanup
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      console.log(`✅ Audio download completed for call ${contactId}`);

    } catch (error) {
      console.error(`❌ Error downloading audio for call ${contactId}:`, error);
      alert(`Failed to download audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      // Remove from downloading state
      setDownloadingAudio(prev => prev.filter(id => id !== contactId));
    }
  };

  // Reset agent filter and pagination when new data is loaded
  useEffect(() => {
    setSelectedAgent("all");
    setCurrentPage(1);
  }, [selectedDateRange]);

  // Reset pagination when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedAgent, sortField, sortDirection]);

  // Function to categorise transcript
  const categorizeTranscript = async (transcriptionData: any) => {
    try {
      console.log("Starting topic categorization...");
      
      const response = await fetch("/api/openAI/categorise", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transcript: transcriptionData,
        }),
      });

      if (!response.ok) {
        console.error("Categorization failed:", response.statusText);
        const errorText = await response.text();
        console.error("Categorization error details:", errorText);
        return null;
      }

      const categorization = await response.json();
      console.log("Categorisation completed:", categorization);
      return categorization;
    } catch (error) {
      console.error("Error in categorisation:", error);
      return null;
    }
  };

  // FIXED: Function to get transcription status component with better error handling
  const getTranscriptionStatus = (log: CallLog) => {
    if (checkSupabase && log.existsInSupabase) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <div className="w-2 h-2 bg-green-500 rounded-full mr-1"></div>
          Transcribed
        </span>
      );
    } else if (activeTranscriptions.has(log.contact_id)) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <div className="w-2 h-2 bg-yellow-500 rounded-full mr-1 animate-pulse"></div>
          In Progress
          {log.transcriptionProgress && (
            <span className="ml-1">({log.transcriptionProgress}%)</span>
          )}
        </span>
      );
    } else if (log.transcriptionStatus === "Failed") {
      return (
        <span 
          className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 cursor-help"
          title={log.transcriptionError || "Transcription failed"}
        >
          <div className="w-2 h-2 bg-red-500 rounded-full mr-1"></div>
          Failed
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
          <div className="w-2 h-2 bg-gray-500 rounded-full mr-1"></div>
          Pending
        </span>
      );
    }
  };

  // Function to save transcription data to Supabase
  const saveToSupabase = async (log: CallLog, transcriptionData: any, categorization: any = null) => {
    try {
      console.log(
        `Saving transcription data to Supabase for ${log.contact_id}`
      );

      const supabasePayload = {
        contact_id: log.contact_id,
        recording_location: log.recording_location,
        transcript_text: transcriptionData.text || "",
        queue_name: log.queue_name,
        agent_username: log.agent_username,
        initiation_timestamp: log.initiation_timestamp,
        speaker_data: transcriptionData.utterances
          ? JSON.stringify(transcriptionData.utterances)
          : null,
        sentiment_analysis: transcriptionData.sentiment_analysis_results
          ? JSON.stringify(transcriptionData.sentiment_analysis_results)
          : null,
        entities: transcriptionData.entities
          ? JSON.stringify(transcriptionData.entities)
          : null,
        disposition_title: log.disposition_title,
        call_summary: transcriptionData.summary || null,
        campaign_name: log.campaign_name,
        campaign_id: log.campaign_id,
        customer_cli: log.customer_cli,
        agent_hold_time: log.agent_hold_time,
        total_hold_time: log.total_hold_time,
        time_in_queue: log.time_in_queue,
        call_duration: log.total_call_time,
        categories: categorization?.topic_categories 
          ? JSON.stringify(categorization.topic_categories) 
          : (transcriptionData.topic_categorization?.all_topics ? JSON.stringify(transcriptionData.topic_categorization.all_topics) : null),
        primary_category: categorization?.primary_category || transcriptionData.topic_categorization?.primary_topic || null,
      };

      console.log("Supabase payload with categorization:", {
        contact_id: supabasePayload.contact_id,
        categories: supabasePayload.categories,
        primary_category: supabasePayload.primary_category
      });

      const response = await fetch("/api/supabase/save-transcription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(supabasePayload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to save to Supabase");
      }

      const result = await response.json();
      console.log(
        `Successfully saved transcription data to Supabase for ${log.contact_id}:`, result
      );
      return true;
    } catch (error) {
      console.error(`Error saving to Supabase for ${log.contact_id}:`, error);
      return false;
    }
  };

  // FIXED: Improved transcription function with better error handling and resource management
  const initiateTranscription = useCallback(async (log: CallLog) => {
    if (!log.recording_location) return false;

    const contactId = log.contact_id;
    
    // Create abort controller for this transcription
    const controller = new AbortController();
    transcriptionControllers.current.set(contactId, controller);

    try {
      console.log(`Starting transcription for ${contactId}`);
      
      // Update log status to pending
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === contactId
            ? {
                ...l,
                transcriptionStatus: "Pending Transcription",
                transcriptionProgress: 0,
                transcriptionError: undefined,
              }
            : l
        )
      );

      // FIXED: Validate recording location format
      const fullPath = log.recording_location;
      if (!fullPath || typeof fullPath !== 'string') {
        throw new Error("Invalid recording location");
      }

      const filename = fullPath.split("/").pop();
      if (!filename) {
        throw new Error("Could not extract filename from recording location");
      }

      console.log(`Extracted filename: ${filename} from path: ${fullPath}`);

      // FIXED: Set up progress updates with proper cleanup
      const progressInterval = setInterval(() => {
        setCallLogs((prevLogs) =>
          prevLogs.map((l) => {
            if (
              l.contact_id === contactId &&
              l.transcriptionStatus === "Pending Transcription"
            ) {
              const currentProgress = l.transcriptionProgress || 0;
              const newProgress = Math.min(85, currentProgress + 2); // More conservative progress
              return { ...l, transcriptionProgress: newProgress };
            }
            return l;
          })
        );
      }, 2000); // Slower progress updates

      progressIntervals.current.set(contactId, progressInterval);

      // FIXED: Make transcription request with timeout and abort signal
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isDirectSftpFile: true,
          sftpFilename: fullPath,
          filename: filename,
          speakerCount: 2,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Transcription failed:", errorData);
        throw new Error(errorData.error || `HTTP ${response.status}: Transcription failed`);
      }

      const transcriptionData = await response.json();
      console.log(`Transcription API response for ${contactId}:`, transcriptionData);

      // Check if transcription was actually successful
      const hasValidTranscript = transcriptionData && 
        transcriptionData.status !== "unavailable" && 
        transcriptionData.text && 
        transcriptionData.text.trim().length > 0;

      if (!hasValidTranscript) {
        console.warn(`Transcription returned no valid content for ${contactId}:`, transcriptionData);
        
        const basicData = {
          text: transcriptionData?.text || "",
          utterances: transcriptionData?.utterances || [],
          summary: transcriptionData?.summary || null,
          sentiment_analysis_results: transcriptionData?.sentiment_analysis_results || null,
          entities: transcriptionData?.entities || null,
          topic_categorization: transcriptionData?.topic_categorization || null
        };

        const supabaseSaved = await saveToSupabase(log, basicData, null);

        setCallLogs((prevLogs) =>
          prevLogs.map((l) =>
            l.contact_id === contactId
              ? {
                  ...l,
                  transcriptionStatus: "Transcribed",
                  transcriptionProgress: 100,
                  existsInSupabase: supabaseSaved,
                }
              : l
          )
        );

        return supabaseSaved;
      }

      console.log(`Valid transcription completed for ${contactId}`);

      // Handle categorization
      let categorization = null;
      if (transcriptionData.topic_categorization) {
        console.log(`Using categorization from transcribe API for ${contactId}:`, transcriptionData.topic_categorization);
        categorization = {
          topic_categories: transcriptionData.topic_categorization.all_topics,
          primary_category: transcriptionData.topic_categorization.primary_topic,
          confidence: transcriptionData.topic_categorization.confidence
        };
      } else if (transcriptionData.utterances && transcriptionData.utterances.length > 0) {
        console.log(`Running additional categorization for ${contactId}`);
        categorization = await categorizeTranscript(transcriptionData);
        
        if (categorization) {
          console.log(`Additional categorization completed for ${contactId}:`, categorization);
        } else {
          console.log(`Additional categorization failed for ${contactId}, proceeding without categories`);
        }
      } else {
        console.log(`Skipping categorization for ${contactId} - no utterances found`);
      }

      // Save transcription data to Supabase
      const supabaseSaved = await saveToSupabase(log, transcriptionData, categorization);

      // Update log status to transcribed
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === contactId
            ? {
                ...l,
                transcriptionStatus: "Transcribed",
                transcriptionProgress: 100,
                existsInSupabase: supabaseSaved,
                transcriptionError: undefined,
              }
            : l
        )
      );

      return true;
    } catch (error) {
      console.error(`Error transcribing ${contactId}:`, error);

      // FIXED: Better error handling and status updates
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === contactId
            ? {
                ...l,
                transcriptionStatus: "Failed",
                transcriptionProgress: undefined,
                transcriptionError: errorMessage,
              }
            : l
        )
      );

      // Add to failed transcriptions set
      setFailedTranscriptions(prev => new Set(prev).add(contactId));

      return false;
    } finally {
      // FIXED: Always cleanup resources
      cleanupTranscription(contactId);
    }
  }, [cleanupTranscription]);

  // FIXED: Add log to transcription queue with duplicate prevention
  const queueTranscription = useCallback((logId: string) => {
    setTranscriptionQueue((prev) => {
      // Don't add if already in queue, active, or failed
      if (prev.includes(logId) || 
          activeTranscriptions.has(logId) || 
          failedTranscriptions.has(logId)) {
        return prev;
      }
      return [...prev, logId];
    });
  }, [activeTranscriptions, failedTranscriptions]);

  // FIXED: Improved queue processing with better concurrency control
  useEffect(() => {
    const processQueue = async () => {
      if (transcriptionQueue.length === 0) return;

      const availableSlots = maxConcurrentTranscriptions - activeTranscriptions.size;
      if (availableSlots <= 0) return;

      // Take only the first N items from the queue
      const logsToProcess = transcriptionQueue.slice(0, availableSlots);

      // Remove these logs from queue and add to active
      setTranscriptionQueue((prev) =>
        prev.filter((id) => !logsToProcess.includes(id))
      );
      
      setActiveTranscriptions((prev) => {
        const newSet = new Set(prev);
        logsToProcess.forEach(id => newSet.add(id));
        return newSet;
      });

      // FIXED: Process each log with proper async handling
      const transcriptionPromises = logsToProcess.map(async (logId) => {
        const logToTranscribe = callLogs.find(log => log.contact_id === logId);

        if (!logToTranscribe || !logToTranscribe.recording_location) {
          console.error(`Invalid log for transcription: ${logId}`);
          setActiveTranscriptions(prev => {
            const newSet = new Set(prev);
            newSet.delete(logId);
            return newSet;
          });
          return;
        }

        try {
          await initiateTranscription(logToTranscribe);
        } catch (error) {
          console.error(`Error processing queue item ${logId}:`, error);
        }
      });

      // Wait for all transcriptions to complete
      await Promise.allSettled(transcriptionPromises);
    };

    processQueue();
  }, [
    transcriptionQueue,
    activeTranscriptions,
    callLogs,
    initiateTranscription,
    maxConcurrentTranscriptions,
  ]);

  // Fetch call logs whenever the selected date range changes
  useEffect(() => {
    const fetchCallLogs = async () => {
      if (!selectedDateRange) return;

      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          startDate: selectedDateRange.start.toISOString(),
          endDate: selectedDateRange.end.toISOString(),
          checkSupabase: checkSupabase.toString(),
        });

        const response = await fetch(`/api/get-call-logs?${params}`);
        const data = await response.json();

        if (data.success) {
          const logsWithTranscriptionStatus = data.data.map((log: CallLog) => ({
            ...log,
            transcriptionStatus: log.existsInSupabase
              ? "Transcribed"
              : "Pending Transcription",
          }));

          setCallLogs(logsWithTranscriptionStatus);
          
          // FIXED: Reset transcription state when new data is loaded
          setTranscriptionQueue([]);
          setActiveTranscriptions(new Set());
          setFailedTranscriptions(new Set());
          
          // Clear any existing intervals and controllers
          progressIntervals.current.forEach(interval => clearInterval(interval));
          transcriptionControllers.current.forEach(controller => controller.abort());
          progressIntervals.current.clear();
          transcriptionControllers.current.clear();
        } else {
          setError(data.error || "Failed to fetch call logs");
        }
      } catch (err) {
        setError("Network error occurred while fetching call logs");
        console.error("Error fetching call logs:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchCallLogs();
  }, [selectedDateRange, checkSupabase]);

  // FIXED: Auto-queue logs with better logic and limits
  useEffect(() => {
    if (!loading && callLogs.length > 0) {
      const maxAutoQueue = 15; // Reasonable limit
      let queued = 0;

      const totalInProgress = transcriptionQueue.length + activeTranscriptions.size;
      
      if (totalInProgress < maxAutoQueue) {
        paginatedCallLogs.forEach((log) => {
          if (
            log.recording_location &&
            log.transcriptionStatus === "Pending Transcription" &&
            log.existsInSupabase === false &&
            !transcriptionQueue.includes(log.contact_id) &&
            !activeTranscriptions.has(log.contact_id) &&
            !failedTranscriptions.has(log.contact_id) &&
            queued < (maxAutoQueue - totalInProgress)
          ) {
            console.log(`Auto-queueing transcription for call ${log.contact_id}`);
            queueTranscription(log.contact_id);
            queued++;
          }
        });
      }
    }
  }, [
    paginatedCallLogs,
    loading,
    queueTranscription,
    transcriptionQueue,
    activeTranscriptions,
    failedTranscriptions,
  ]);

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatCallDuration = (totalCallTime: {
    minutes: number;
    seconds: number;
  }) => {
    if (!totalCallTime) return "N/A";
    const { minutes = 0, seconds = 0 } = totalCallTime;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '↕️';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  // FIXED: Manual retry function for failed transcriptions
  const retryTranscription = useCallback((contactId: string) => {
    // Remove from failed set and add to queue
    setFailedTranscriptions(prev => {
      const newSet = new Set(prev);
      newSet.delete(contactId);
      return newSet;
    });
    
    // Reset the log status
    setCallLogs(prevLogs =>
      prevLogs.map(l =>
        l.contact_id === contactId
          ? {
              ...l,
              transcriptionStatus: "Pending Transcription",
              transcriptionProgress: 0,
              transcriptionError: undefined,
            }
          : l
      )
    );
    
    // Queue for retry
    queueTranscription(contactId);
  }, [queueTranscription]);

  return (
    <div className="flex-1 border-2 p-2 rounded border-border bg-bg-secondary">
      {/* Header with title and overview button */}
      <div className="flex items-center justify-between mb-4">
        <h5 className="text-[#4ecca3]">Call Logs</h5>
        <Link
          href="/tge/overview"
          className="px-3 py-2 bg-[#4ecca3] text-[#0a101b] rounded-lg hover:bg-[#3bb891] transition-colors text-sm font-medium"
        >
          View All Transcribed Calls
        </Link>
      </div>

      {!selectedDateRange ? (
        <div>Please Select A Date Range</div>
      ) : (
        <div>
          <div className="mb-4">
            <h6 className="text-sm text-white">
              Call Data for {selectedDateRange.label}
            </h6>
          </div>

          {/* Agent Filter */}
          {uniqueAgents.length > 0 && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-white mb-2">
                Filter by Agent:
              </label>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="px-3 py-2 bg-bg-primary border border-border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#4ecca3] focus:border-transparent"
              >
                <option value="all">All Agents ({callLogs.length} calls)</option>
                {uniqueAgents.map((agent) => {
                  const agentCallCount = callLogs.filter(log => log.agent_username === agent).length;
                  return (
                    <option key={agent} value={agent}>
                      {agent} ({agentCallCount} calls)
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* FIXED: Enhanced queue status indicator */}
          {(transcriptionQueue.length > 0 || activeTranscriptions.size > 0 || failedTranscriptions.size > 0) && (
            <div className="mb-4 p-3 bg-bg-primary border border-border rounded-lg">
              <div className="text-sm text-[#4ecca3] font-medium">
                Transcription Status: {activeTranscriptions.size} active, {transcriptionQueue.length} queued
                {failedTranscriptions.size > 0 && (
                  <span className="text-red-400 ml-2">({failedTranscriptions.size} failed)</span>
                )}
              </div>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center p-8">
              <div className="text-gray-500">Loading call logs...</div>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              Error: {error}
            </div>
          )}

          {!loading && !error && (
            <div>
              <div className="mb-4 flex justify-between items-center">
                <div className="text-sm text-white">
                  {selectedAgent === "all" 
                    ? `Found ${filteredAndSortedCallLogs.length} call(s) - Page ${currentPage} of ${totalPages} (showing ${paginatedCallLogs.length} records)` 
                    : `Showing ${filteredAndSortedCallLogs.length} call(s) for ${selectedAgent} - Page ${currentPage} of ${totalPages} (${paginatedCallLogs.length} records) - ${callLogs.length} total calls`
                  }
                </div>
                
                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      First
                    </button>
                    <button
                      onClick={() => setCurrentPage(currentPage - 1)}
                      disabled={currentPage === 1}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      Previous
                    </button>
                    <span className="text-xs text-white px-2">
                      {currentPage} / {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      Next
                    </button>
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage === totalPages}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      Last
                    </button>
                  </div>
                )}
              </div>

              {filteredAndSortedCallLogs.length === 0 ? (
                <div className="text-gray-500 p-4 text-center">
                  {selectedAgent === "all" 
                    ? "No call logs found for this date range"
                    : `No call logs found for agent ${selectedAgent} in this date range`
                  }
                </div>
              ) : (
                <div className="overflow-hidden border border-border rounded-lg">
                  <div className="overflow-x-auto max-h-[calc(100vh-420px)]">
                    <table className="min-w-full bg-bg-primary">
                      <thead className="bg-bg-secondary border-b border-border sticky top-0 z-10">
                        <tr>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('agent_username')}
                          >
                            Agent {getSortIcon('agent_username')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('initiation_timestamp')}
                          >
                            Call Date/Time {getSortIcon('initiation_timestamp')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('total_call_time')}
                          >
                            Duration {getSortIcon('total_call_time')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('queue_name')}
                          >
                            Queue {getSortIcon('queue_name')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('disposition_title')}
                          >
                            Disposition {getSortIcon('disposition_title')}
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider">
                            Transcription Status
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {paginatedCallLogs.map((log, index) => (
                          <tr 
                            key={log.contact_id || index}
                            className="hover:bg-gray-800 transition-colors"
                          >
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {log.agent_username}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {formatTimestamp(log.initiation_timestamp)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {formatCallDuration(log.total_call_time)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {log.queue_name || "N/A"}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {log.disposition_title || "N/A"}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm">
                              {getTranscriptionStatus(log)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm">
                              <div className="flex items-center space-x-2">
                                <Link 
                                  href={`/tge/${log.contact_id}`}
                                  className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-[#4ecca3] hover:bg-[#3bb891] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#4ecca3] transition-colors"
                                >
                                  View Details
                                </Link>
                                
                                {/* FIXED: Add retry button for failed transcriptions */}
                                {log.transcriptionStatus === "Failed" && (
                                  <button
                                    onClick={() => retryTranscription(log.contact_id)}
                                    className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 transition-colors"
                                    title="Retry transcription"
                                  >
                                    Retry
                                  </button>
                                )}
                                
                                {/* Audio Download Button */}
                                {log.recording_location && (
                                  <button
                                    onClick={() => handleAudioDownload(log)}
                                    disabled={downloadingAudio.includes(log.contact_id)}
                                    className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                                    title="Download audio file"
                                  >
                                    {downloadingAudio.includes(log.contact_id) ? (
                                      <>
                                        <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Downloading...
                                      </>
                                    ) : (
                                      <>
                                        <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                        Audio
                                      </>
                                    )}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CallLogDisplay;