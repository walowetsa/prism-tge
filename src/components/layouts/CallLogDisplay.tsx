/* eslint-disable @typescript-eslint/no-unused-vars */
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
  transcriptionStatus?: "Transcribed" | "Pending Transcription" | "Failed" | "Processing";
  transcriptionProgress?: number;
  transcriptionError?: string;
  // Supabase fields for transcribed calls
  transcript_text?: string;
  call_summary?: string;
  sentiment_analysis?: string;
  primary_category?: string;
  categories?: string;
  created_at?: string;
  updated_at?: string;
}

interface ProcessingSummary {
  totalCalls: number;
  existingTranscriptions: number;
  missingTranscriptions: number;
  processedThisRequest: number;
  errors: number;
}

interface ProcessingError {
  contact_id: string;
  error: string;
}

// Enhanced job tracking interface
interface ProcessingJob {
  id: string;
  contact_ids: string[];
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: {
    total: number;
    completed: number;
    failed: number;
    current_contact_id?: string;
  };
  created_at: string;
  updated_at: string;
  errors: Array<{
    contact_id: string;
    error: string;
  }>;
}

interface SupabaseCallRecord {
  contact_id: string;
  agent_username: string;
  transcript_text: string;
  call_summary?: string;
  sentiment_analysis?: string;
  primary_category?: string;
  categories?: string;
  queue_name?: string;
  disposition_title?: string;
  recording_location?: string;
  initiation_timestamp: string;
  call_duration?: any;
  created_at: string;
  updated_at: string;
}

type SortField = 'agent_username' | 'initiation_timestamp' | 'total_call_time' | 'queue_name' | 'disposition_title';
type SortDirection = 'asc' | 'desc';

const ITEMS_PER_PAGE = 100;
const JOB_STATUS_POLL_INTERVAL = 5000; // 5 seconds
const SUPABASE_REFRESH_INTERVAL = 15000; // 15 seconds

const CallLogDisplay = ({
  selectedDateRange,
  checkSupabase = true,
}: {
  selectedDateRange: DateRange | null;
  checkSupabase?: boolean;
}) => {
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [supabaseRecords, setSupabaseRecords] = useState<SupabaseCallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingSupabase, setLoadingSupabase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Enhanced processing state
  const [activeJobs, setActiveJobs] = useState<Map<string, ProcessingJob>>(new Map());
  const [processingSummary, setProcessingSummary] = useState<ProcessingSummary | null>(null);
  const [lastSupabaseUpdate, setLastSupabaseUpdate] = useState<string | null>(null);
  
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>('initiation_timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [downloadingAudio, setDownloadingAudio] = useState<string[]>([]);

  // Refs for tracking and cleanup
  const jobPollingIntervals = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const supabaseRefreshInterval = useRef<NodeJS.Timeout | null>(null);

  // Fetch all transcribed calls from Supabase
  const fetchSupabaseRecords = async () => {
    setLoadingSupabase(true);
    try {
      console.log('📊 Fetching all transcribed calls from Supabase...');
      
      const response = await fetch('/api/supabase/get-all-transcriptions');
      const data = await response.json();

      if (data.success) {
        setSupabaseRecords(data.data || []);
        setLastSupabaseUpdate(new Date().toISOString());
        console.log(`✅ Loaded ${data.data?.length || 0} transcribed calls from Supabase`);
      } else {
        console.error('Failed to fetch Supabase records:', data.error);
      }
    } catch (err) {
      console.error('Error fetching Supabase records:', err);
    } finally {
      setLoadingSupabase(false);
    }
  };

  // Check job status
  const checkJobStatus = async (jobId: string): Promise<ProcessingJob | null> => {
    try {
      const response = await fetch(`/api/process-calls?jobId=${jobId}`, {
        method: 'PUT'
      });
      
      if (!response.ok) {
        console.error(`Job status check failed: ${response.status}`);
        return null;
      }

      const data = await response.json();
      return data.success ? data.job : null;
    } catch (error) {
      console.error(`Error checking job status for ${jobId}:`, error);
      return null;
    }
  };

  // Start polling for job status
  const startJobPolling = (jobId: string) => {
    // Clear existing interval if any
    const existingInterval = jobPollingIntervals.current.get(jobId);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    const interval = setInterval(async () => {
      const jobStatus = await checkJobStatus(jobId);
      
      if (jobStatus) {
        setActiveJobs(prev => {
          const newMap = new Map(prev);
          newMap.set(jobId, jobStatus);
          return newMap;
        });

        // If job is completed or failed, stop polling and refresh data
        if (jobStatus.status === 'completed' || jobStatus.status === 'failed') {
          clearInterval(interval);
          jobPollingIntervals.current.delete(jobId);
          
          // Refresh Supabase data to get newly transcribed calls
          await fetchSupabaseRecords();
          
          // Remove job from active jobs after a delay
          setTimeout(() => {
            setActiveJobs(prev => {
              const newMap = new Map(prev);
              newMap.delete(jobId);
              return newMap;
            });
          }, 5000);

          console.log(`✅ Job ${jobId} ${jobStatus.status}. Polling stopped.`);
        }
      } else {
        // Job not found, stop polling
        clearInterval(interval);
        jobPollingIntervals.current.delete(jobId);
        setActiveJobs(prev => {
          const newMap = new Map(prev);
          newMap.delete(jobId);
          return newMap;
        });
      }
    }, JOB_STATUS_POLL_INTERVAL);

    jobPollingIntervals.current.set(jobId, interval);
  };

  // Merge call logs with Supabase records and job status
  const mergedCallLogs = useMemo(() => {
    if (callLogs.length === 0) return [];

    const supabaseMap = new Map(supabaseRecords.map(record => [record.contact_id, record]));
    
    // Get currently processing contact IDs from active jobs
    const processingContactIds = new Set<string>();
    activeJobs.forEach(job => {
      if (job.status === 'processing' || job.status === 'queued') {
        job.contact_ids.forEach(id => processingContactIds.add(id));
      }
    });
    
    return callLogs.map(log => {
      const supabaseRecord = supabaseMap.get(log.contact_id);
      
      if (supabaseRecord) {
        // Merge with Supabase data
        return {
          ...log,
          existsInSupabase: true,
          transcriptionStatus: "Transcribed" as const,
          transcript_text: supabaseRecord.transcript_text,
          call_summary: supabaseRecord.call_summary,
          sentiment_analysis: supabaseRecord.sentiment_analysis,
          primary_category: supabaseRecord.primary_category,
          categories: supabaseRecord.categories,
          created_at: supabaseRecord.created_at,
          updated_at: supabaseRecord.updated_at,
        };
      } else if (processingContactIds.has(log.contact_id)) {
        // Call is being processed
        return {
          ...log,
          existsInSupabase: false,
          transcriptionStatus: "Processing" as const,
        };
      } else {
        // Call log without transcription
        return {
          ...log,
          existsInSupabase: false,
          transcriptionStatus: "Pending Transcription" as const,
        };
      }
    });
  }, [callLogs, supabaseRecords, activeJobs]);

  // Get unique agents from merged data
  const uniqueAgents = useMemo(() => {
    const agents = Array.from(new Set(mergedCallLogs.map(log => log.agent_username)))
      .filter(agent => agent && agent.trim() !== "")
      .sort();
    return agents;
  }, [mergedCallLogs]);

  // Filter and sort merged call logs
  const filteredAndSortedCallLogs = useMemo(() => {
    let filtered = mergedCallLogs;
    
    if (selectedAgent !== "all") {
      filtered = mergedCallLogs.filter(log => log.agent_username === selectedAgent);
    }
    
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
  }, [mergedCallLogs, selectedAgent, sortField, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedCallLogs.length / ITEMS_PER_PAGE);
  const paginatedCallLogs = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return filteredAndSortedCallLogs.slice(startIndex, endIndex);
  }, [filteredAndSortedCallLogs, currentPage]);

  // Calculate processing summary from merged data and active jobs
  const calculatedSummary = useMemo(() => {
    const total = mergedCallLogs.length;
    const transcribed = mergedCallLogs.filter(log => log.existsInSupabase).length;
    const missing = mergedCallLogs.filter(log => !log.existsInSupabase && log.recording_location).length;
    
    // Calculate totals from active jobs
    let totalProcessed = 0;
    let totalFailed = 0;
    activeJobs.forEach(job => {
      totalProcessed += job.progress.completed;
      totalFailed += job.progress.failed;
    });
    
    return {
      totalCalls: total,
      existingTranscriptions: transcribed,
      missingTranscriptions: missing,
      processedThisRequest: totalProcessed,
      errors: totalFailed
    };
  }, [mergedCallLogs, activeJobs]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Audio download function (unchanged)
  const handleAudioDownload = async (log: CallLog) => {
    if (!log.recording_location) {
      alert("No audio file available for this call");
      return;
    }

    const contactId = log.contact_id;
    
    if (downloadingAudio.includes(contactId)) return;

    setDownloadingAudio(prev => [...prev, contactId]);

    try {
      console.log(`🎵 Downloading call recording: ${contactId}`);

      const downloadUrl = `/api/sftp/download?filename=${encodeURIComponent(log.recording_location)}`;
      
      const response = await fetch(downloadUrl);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Download failed: ${response.status} - ${errorText}`);
      }

      const blob = await response.blob();
      console.log(`📦 Downloaded: ${blob.size} bytes, type: ${blob.type}`);

      if (blob.size === 0) {
        throw new Error("Downloaded file is empty");
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = log.recording_location.split('/').pop() || `call_${contactId}.wav`;
      
      document.body.appendChild(a);
      a.click();
      
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      console.log(`✅ Download completed for: ${contactId}`);

    } catch (error) {
      console.error(`❌ Download error for ${contactId}:`, error);
      alert(`Failed to download audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDownloadingAudio(prev => prev.filter(id => id !== contactId));
    }
  };

  // Manual processing trigger
  const startProcessing = async () => {
    if (!selectedDateRange) return;

    try {
      const params = new URLSearchParams({
        startDate: selectedDateRange.start.toISOString(),
        endDate: selectedDateRange.end.toISOString(),
        processTranscriptions: 'true',
        maxProcessCount: '5',
      });

      const response = await fetch(`/api/process-calls?${params}`);
      const data = await response.json();

      if (data.success && data.jobId) {
        console.log(`🚀 Started processing job: ${data.jobId}`);
        
        // Add job to active jobs and start polling
        setActiveJobs(prev => {
          const newMap = new Map(prev);
          newMap.set(data.jobId, {
            id: data.jobId,
            contact_ids: [],
            status: 'queued',
            progress: { total: 0, completed: 0, failed: 0 },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            errors: []
          });
          return newMap;
        });
        
        startJobPolling(data.jobId);
      } else {
        console.error('Failed to start processing:', data.error);
        setError(data.error || 'Failed to start processing');
      }
    } catch (err) {
      console.error('Error starting processing:', err);
      setError('Network error occurred while starting processing');
    }
  };

  // Reset filters when data changes
  useEffect(() => {
    setSelectedAgent("all");
    setCurrentPage(1);
  }, [selectedDateRange]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedAgent, sortField, sortDirection]);

  // Setup Supabase refresh interval
  useEffect(() => {
    if (!selectedDateRange) return;

    // Clear existing interval
    if (supabaseRefreshInterval.current) {
      clearInterval(supabaseRefreshInterval.current);
    }

    // Setup new interval for Supabase updates
    supabaseRefreshInterval.current = setInterval(() => {
      console.log('🔄 Periodic Supabase refresh...');
      fetchSupabaseRecords();
    }, SUPABASE_REFRESH_INTERVAL);

    // Cleanup on unmount or date range change
    return () => {
      if (supabaseRefreshInterval.current) {
        clearInterval(supabaseRefreshInterval.current);
        supabaseRefreshInterval.current = null;
      }
    };
  }, [selectedDateRange]);

  // Cleanup job polling on unmount
  useEffect(() => {
    return () => {
      jobPollingIntervals.current.forEach((interval) => {
        clearInterval(interval);
      });
      jobPollingIntervals.current.clear();
      
      if (supabaseRefreshInterval.current) {
        clearInterval(supabaseRefreshInterval.current);
      }
    };
  }, []);

  // Fetch call logs and automatically start processing
  useEffect(() => {
    const fetchCallLogs = async () => {
      if (!selectedDateRange) return;

      setLoading(true);
      setError(null);
      setProcessingSummary(null);

      try {
        // Step 1: Fetch Supabase records first
        console.log('🔍 Step 1: Fetching Supabase transcriptions...');
        await fetchSupabaseRecords();

        // Step 2: Fetch call logs and auto-start processing
        console.log('📊 Step 2: Fetching call logs and starting processing...');
        const params = new URLSearchParams({
          startDate: selectedDateRange.start.toISOString(),
          endDate: selectedDateRange.end.toISOString(),
          processTranscriptions: 'true', // Auto-start processing
          maxProcessCount: '5',
        });

        const response = await fetch(`/api/process-calls?${params}`);
        const data = await response.json();

        if (data.success) {
          setCallLogs(data.data || []);
          console.log('📋 Call logs loaded:', data.summary);

          // If processing job was created, start polling
          if (data.jobId && data.processing) {
            console.log(`🎯 Auto-started processing job: ${data.jobId}`);
            
            setActiveJobs(prev => {
              const newMap = new Map(prev);
              newMap.set(data.jobId, {
                id: data.jobId,
                contact_ids: [],
                status: 'queued',
                progress: { total: 0, completed: 0, failed: 0 },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                errors: []
              });
              return newMap;
            });
            
            startJobPolling(data.jobId);
          }
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

  // Get transcription status with enhanced info
  const getTranscriptionStatus = (log: CallLog) => {
    if (log.existsInSupabase) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
              title={`Transcribed: ${log.transcript_text ? log.transcript_text.substring(0, 100) + '...' : 'No preview'}`}>
          <div className="w-2 h-2 bg-green-500 rounded-full mr-1"></div>
          Transcribed
          {log.primary_category && (
            <span className="ml-1 text-green-600">({log.primary_category})</span>
          )}
        </span>
      );
    } else if (log.transcriptionStatus === "Processing") {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <div className="w-2 h-2 bg-yellow-500 rounded-full mr-1 animate-pulse"></div>
          Processing
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

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatCallDuration = (totalCallTime: { minutes: number; seconds: number }) => {
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
      <div className="flex items-center justify-between mb-4">
        <h5 className="text-[#4ecca3]">Call Logs & Transcriptions</h5>
        <div className="flex items-center gap-2">
          {lastSupabaseUpdate && (
            <div className="text-xs text-gray-400">
              Last updated: {new Date(lastSupabaseUpdate).toLocaleTimeString()}
            </div>
          )}
          <Link
            href="/tge/overview"
            className="px-3 py-2 bg-[#4ecca3] text-[#0a101b] rounded-lg hover:bg-[#3bb891] transition-colors text-sm font-medium"
          >
            View All Transcribed Calls
          </Link>
        </div>
      </div>

      {!selectedDateRange ? (
        <div>Please Select A Date Range</div>
      ) : (
        <div>
          <div className="mb-4">
            <h6 className="text-sm text-white">
              Call Data for {selectedDateRange.label}
              {loadingSupabase && (
                <span className="ml-2 text-xs text-yellow-400">🔄 Refreshing transcriptions...</span>
              )}
            </h6>
          </div>

          {/* Active Jobs Status */}
          {activeJobs.size > 0 && (
            <div className="mb-4 space-y-2">
              {Array.from(activeJobs.values()).map(job => (
                <div key={job.id} className="p-4 bg-blue-900 border border-blue-600 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm text-blue-300 font-medium">
                      🤖 Background Processing Job: {job.id}
                    </div>
                    <div className="text-xs text-blue-200">
                      Status: <span className="font-medium text-white">{job.status}</span>
                    </div>
                  </div>
                  
                  {job.progress.total > 0 && (
                    <>
                      <div className="grid grid-cols-3 gap-2 text-xs text-blue-200 mb-2">
                        <div>Completed: <span className="text-green-400 font-medium">{job.progress.completed}</span></div>
                        <div>Failed: <span className="text-red-400 font-medium">{job.progress.failed}</span></div>
                        <div>Total: <span className="text-white font-medium">{job.progress.total}</span></div>
                      </div>
                      
                      <div className="mb-2">
                        <div className="w-full bg-blue-800 rounded-full h-2">
                          <div 
                            className="bg-blue-400 h-2 rounded-full transition-all duration-500" 
                            style={{ 
                              width: `${((job.progress.completed + job.progress.failed) / job.progress.total) * 100}%` 
                            }}
                          ></div>
                        </div>
                      </div>
                    </>
                  )}
                  
                  {job.progress.current_contact_id && (
                    <div className="text-xs text-blue-300">
                      Currently processing: <span className="font-mono text-white">{job.progress.current_contact_id}</span>
                    </div>
                  )}
                  
                  {job.errors.length > 0 && (
                    <div className="mt-2 text-xs text-red-300">
                      Errors: {job.errors.length} (hover to see details)
                      <div className="mt-1 max-h-16 overflow-y-auto" title={job.errors.map(e => `${e.contact_id}: ${e.error}`).join('\n')}>
                        {job.errors.slice(0, 3).map((err, idx) => (
                          <div key={idx} className="text-red-200">• {err.contact_id}: {err.error.substring(0, 50)}...</div>
                        ))}
                        {job.errors.length > 3 && <div>... and {job.errors.length - 3} more</div>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Enhanced Processing Summary */}
          <div className="mb-4 p-3 bg-bg-primary border border-border rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-[#4ecca3] font-medium">📊 Live Processing Summary</div>
              <div className="flex gap-2">
                <button
                  onClick={fetchSupabaseRecords}
                  className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
                >
                  🔄 Refresh Data
                </button>
                {calculatedSummary.missingTranscriptions > 0 && activeJobs.size === 0 && (
                  <button
                    onClick={startProcessing}
                    className="px-2 py-1 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700"
                  >
                    🚀 Start Processing
                  </button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs text-gray-300">
              <div>Total Calls: <span className="text-white font-medium">{calculatedSummary.totalCalls}</span></div>
              <div>Transcribed: <span className="text-green-400 font-medium">{calculatedSummary.existingTranscriptions}</span></div>
              <div>Missing: <span className="text-yellow-400 font-medium">{calculatedSummary.missingTranscriptions}</span></div>
              <div>Processed: <span className="text-blue-400 font-medium">{calculatedSummary.processedThisRequest}</span></div>
              <div>Errors: <span className="text-red-400 font-medium">{calculatedSummary.errors}</span></div>
            </div>
          </div>

          {/* Enhanced Agent Filter */}
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
                <option value="all">All Agents ({mergedCallLogs.length} calls)</option>
                {uniqueAgents.map((agent) => {
                  const agentCallCount = mergedCallLogs.filter(log => log.agent_username === agent).length;
                  const transcribedCount = mergedCallLogs.filter(log => log.agent_username === agent && log.existsInSupabase).length;
                  return (
                    <option key={agent} value={agent}>
                      {agent} ({agentCallCount} calls, {transcribedCount} transcribed)
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {(loading || loadingSupabase) && (
            <div className="flex items-center justify-center p-8">
              <div className="text-gray-500">
                {loading && loadingSupabase ? "📊 Loading call logs and transcriptions..." : 
                 loading ? "📊 Loading call logs..." : 
                 "🔍 Fetching transcriptions from Supabase..."}
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
              Error: {error}
              <button 
                onClick={() => setError(null)}
                className="ml-2 text-red-500 hover:text-red-700"
              >
                ✕
              </button>
            </div>
          )}

          {!loading && !error && (
            <div>
              <div className="mb-4 flex justify-between items-center">
                <div className="text-sm text-white">
                  {selectedAgent === "all" 
                    ? `Found ${filteredAndSortedCallLogs.length} call(s) - Page ${currentPage} of ${totalPages} (showing ${paginatedCallLogs.length} records)` 
                    : `Showing ${filteredAndSortedCallLogs.length} call(s) for ${selectedAgent} - Page ${currentPage} of ${totalPages} (${paginatedCallLogs.length} records) - ${mergedCallLogs.length} total calls`
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
                            className={`hover:bg-gray-800 transition-colors ${log.existsInSupabase ? 'bg-green-900/20' : ''}`}
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
                                  {log.existsInSupabase ? 'View Transcript' : 'View Details'}
                                </Link>
                                
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