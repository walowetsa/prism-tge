/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useMemo } from "react";
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
  transcriptionStatus?: "Transcribed" | "Pending Transcription";
  transcriptionProgress?: number;
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

  // Transcription state management - INCREASED TO 5 CONCURRENT
  const [transcriptionQueue, setTranscriptionQueue] = useState<string[]>([]);
  const [activeTranscriptions, setActiveTranscriptions] = useState<string[]>(
    []
  );
  const maxConcurrentTranscriptions = 5;

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

  // Handle sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
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
  // TODO: Fix Typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const categorizeTranscript = async (transcriptionData: any) => {
    try {
      console.log("Starting topic categorization...");
      
      // Use the correct API endpoint that matches your route
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

  // Function to get transcription status component
  const getTranscriptionStatus = (log: CallLog) => {
    if (checkSupabase && log.existsInSupabase) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <div className="w-2 h-2 bg-green-500 rounded-full mr-1"></div>
          Transcribed
        </span>
      );
    } else if (activeTranscriptions.includes(log.contact_id)) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <div className="w-2 h-2 bg-yellow-500 rounded-full mr-1 animate-pulse"></div>
          In Progress
          {log.transcriptionProgress && (
            <span className="ml-1">({log.transcriptionProgress}%)</span>
          )}
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
          <div className="w-2 h-2 bg-red-500 rounded-full mr-1"></div>
          Pending
        </span>
      );
    }
  };

  // Function to save transcription data to Supabase
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        // Updated categorization mapping
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

  // Function to initiate transcription for a specific log
  const initiateTranscription = useCallback(async (log: CallLog) => {
    if (!log.recording_location) return false;

    try {
      console.log(`Starting transcription for ${log.contact_id}`);
      // Update log status to pending
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === log.contact_id
            ? {
                ...l,
                transcriptionStatus: "Pending Transcription",
                transcriptionProgress: 0,
              }
            : l
        )
      );

      // Extract the filename from recording_location
      const fullPath = log.recording_location;
      const filename = fullPath.split("/").pop();

      if (!filename) {
        throw new Error("Could not extract filename from recording location");
      }

      console.log(`Extracted filename: ${filename} from path: ${fullPath}`);

      // Start the transcription process
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
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Transcription failed:", errorData);
        throw new Error(errorData.error || "Transcription failed");
      }

      // Get the transcription data from the response
      const transcriptionData = await response.json();
      console.log(`Transcription API response for ${log.contact_id}:`, transcriptionData);

      // Check if transcription was actually successful
      const hasValidTranscript = transcriptionData && 
        transcriptionData.status !== "unavailable" && 
        transcriptionData.text && 
        transcriptionData.text.trim().length > 0;

      if (!hasValidTranscript) {
        console.warn(`Transcription returned no valid content for ${log.contact_id}:`, transcriptionData);
        
        // Still try to save basic call log info even without transcript
        const basicData = {
          text: transcriptionData?.text || "",
          utterances: transcriptionData?.utterances || [],
          summary: transcriptionData?.summary || null,
          sentiment_analysis_results: transcriptionData?.sentiment_analysis_results || null,
          entities: transcriptionData?.entities || null,
          topic_categorization: transcriptionData?.topic_categorization || null
        };

        // Save basic info to Supabase without additional categorization
        const supabaseSaved = await saveToSupabase(log, basicData, null);

        // Update log status
        setCallLogs((prevLogs) =>
          prevLogs.map((l) =>
            l.contact_id === log.contact_id
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

      console.log(`Valid transcription completed for ${log.contact_id}`);

      // Check if categorization was already done by the transcribe API
      let categorization = null;
      if (transcriptionData.topic_categorization) {
        console.log(`Using categorization from transcribe API for ${log.contact_id}:`, transcriptionData.topic_categorization);
        categorization = {
          topic_categories: transcriptionData.topic_categorization.all_topics,
          primary_category: transcriptionData.topic_categorization.primary_topic,
          confidence: transcriptionData.topic_categorization.confidence
        };
      } else if (transcriptionData.utterances && transcriptionData.utterances.length > 0) {
        // Fallback: categorize if not already done
        console.log(`Running additional categorization for ${log.contact_id}`);
        categorization = await categorizeTranscript(transcriptionData);
        
        if (categorization) {
          console.log(`Additional categorization completed for ${log.contact_id}:`, categorization);
        } else {
          console.log(`Additional categorization failed for ${log.contact_id}, proceeding without categories`);
        }
      } else {
        console.log(`Skipping categorization for ${log.contact_id} - no utterances found`);
      }

      // Save transcription data to Supabase (with categorization if available)
      const supabaseSaved = await saveToSupabase(log, transcriptionData, categorization);

      // Update log status to transcribed and mark as existing in Supabase
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === log.contact_id
            ? {
                ...l,
                transcriptionStatus: "Transcribed",
                transcriptionProgress: 100,
                existsInSupabase: supabaseSaved, // Update based on whether save was successful
              }
            : l
        )
      );

      return true;
    } catch (error) {
      console.error(`Error transcribing ${log.contact_id}:`, error);

      // Reset status to Pending Transcription on error
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === log.contact_id
            ? {
                ...l,
                transcriptionStatus: "Pending Transcription",
                transcriptionProgress: undefined,
              }
            : l
        )
      );

      return false;
    } finally {
      // Remove this log from active transcriptions when done
      setActiveTranscriptions((prev) =>
        prev.filter((id) => id !== log.contact_id)
      );
    }
  }, []);

  // Add log to transcription queue
  const queueTranscription = useCallback((logId: string) => {
    setTranscriptionQueue((prev) => {
      // Don't add if already in queue or active
      if (prev.includes(logId)) return prev;
      return [...prev, logId];
    });
  }, []);

  // Process transcription queue
  useEffect(() => {
    const processQueue = async () => {
      // If queue is empty or we've reached max concurrent transcriptions, do nothing
      if (transcriptionQueue.length === 0) return;

      // Calculate how many more transcriptions we can start
      const availableSlots =
        maxConcurrentTranscriptions - activeTranscriptions.length;

      if (availableSlots <= 0) return;

      // Take the first N items from the queue (up to availableSlots)
      const logsToProcess = transcriptionQueue.slice(0, availableSlots);

      // Move these logs from queue to active transcriptions
      setTranscriptionQueue((prev) =>
        prev.filter((id) => !logsToProcess.includes(id))
      );
      setActiveTranscriptions((prev) => [...prev, ...logsToProcess]);

      // Process each log concurrently
      logsToProcess.forEach(async (logId) => {
        // Find the log in our call logs
        const logToTranscribe = callLogs.find(
          (log) => log.contact_id === logId
        );

        if (!logToTranscribe || !logToTranscribe.recording_location) {
          // Remove invalid logs from active transcriptions
          setActiveTranscriptions((prev) => prev.filter((id) => id !== logId));
          return;
        }

        // Set up progress updates for this log - REDUCED INTERVAL FOR BETTER UX WITH 5 CONCURRENT
        const progressInterval = setInterval(() => {
          setCallLogs((prevLogs) =>
            prevLogs.map((l) => {
              if (
                l.contact_id === logId &&
                l.transcriptionStatus === "Pending Transcription"
              ) {
                // Increment progress by 3% until we reach 90% (real completion will set it to 100%)
                const currentProgress = l.transcriptionProgress || 0;
                const newProgress = Math.min(90, currentProgress + 3);
                return { ...l, transcriptionProgress: newProgress };
              }
              return l;
            })
          );
        }, 1500); // REDUCED FROM 2000ms TO 1500ms FOR SMOOTHER PROGRESS WITH MULTIPLE CONCURRENT

        try {
          // Start transcription
          await initiateTranscription(logToTranscribe);
        } catch (error) {
          console.error(`Error processing queue item ${logId}:`, error);
        } finally {
          clearInterval(progressInterval);
        }
      });
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
          // Set transcription status based on existsInSupabase
          const logsWithTranscriptionStatus = data.data.map((log: CallLog) => ({
            ...log,
            transcriptionStatus: log.existsInSupabase
              ? "Transcribed"
              : "Pending Transcription",
          }));

          setCallLogs(logsWithTranscriptionStatus);
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

  // Auto-queue logs that need transcription when logs are loaded - INCREASED AUTO-QUEUE LIMIT
  useEffect(() => {
    if (!loading && callLogs.length > 0) {
      // INCREASED from 10 to 20 to better handle 5 concurrent transcriptions
      const maxAutoQueue = 20;
      let queued = 0;

      if (
        transcriptionQueue.length + activeTranscriptions.length <
        maxAutoQueue
      ) {
        paginatedCallLogs.forEach((log) => {
          if (
            log.recording_location &&
            log.transcriptionStatus === "Pending Transcription" &&
            log.existsInSupabase === false && // Only auto-queue if NOT in Supabase
            queued <
              maxAutoQueue -
                transcriptionQueue.length -
                activeTranscriptions.length
          ) {
            console.log(
              `Auto-queueing transcription for call ${log.contact_id} (not in Supabase)`
            );
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
    transcriptionQueue.length,
    activeTranscriptions.length,
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

          {/* Queue status indicator for 5 concurrent */}
          {(transcriptionQueue.length > 0 || activeTranscriptions.length > 0) && (
            <div className="mb-4 p-3 bg-bg-primary border border-border rounded-lg">
              <div className="text-sm text-[#4ecca3] font-medium">
                Processing transcriptions: {activeTranscriptions.length} active, {transcriptionQueue.length} queued
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
                              <Link 
                                href={`/tge/${log.contact_id}`}
                                className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-[#4ecca3] hover:bg-[#3bb891] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#4ecca3] transition-colors"
                              >
                                View Details
                              </Link>
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