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

interface AutoProcessingState {
  isRunning: boolean;
  currentBatch: number;
  totalBatches: number;
  processed: number;
  failed: number;
  remaining: number;
  currentCallIndex: number; // NEW: Track which call we're on
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
const BATCH_SIZE = 5;

// Global flag to prevent multiple auto-processing sessions
const GLOBAL_PROCESSING_KEY = 'autoProcessingActive';

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
  const [processing, setProcessing] = useState(false);
  const [processingSummary, setProcessingSummary] = useState<ProcessingSummary | null>(null);
  const [processingErrors, setProcessingErrors] = useState<ProcessingError[]>([]);
  const [autoProcessing, setAutoProcessing] = useState<AutoProcessingState>({
    isRunning: false,
    currentBatch: 0,
    totalBatches: 0,
    processed: 0,
    failed: 0,
    remaining: 0,
    currentCallIndex: 0
  });
  const [lastSupabaseUpdate, setLastSupabaseUpdate] = useState<string | null>(null);
  
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>('initiation_timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [downloadingAudio, setDownloadingAudio] = useState<string[]>([]);

  // NEW: Simple refs for tracking
  const autoProcessingInitiated = useRef<string | null>(null);
  const isAutoProcessingRunning = useRef<boolean>(false);
  const callsToProcess = useRef<CallLog[]>([]); // NEW: Store all calls that need processing
  const currentBatchIndex = useRef<number>(0); // NEW: Track which batch we're on

  // Fetch all transcribed calls from Supabase
  const fetchSupabaseRecords = async () => {
    setLoadingSupabase(true);
    try {
      const timestamp = new Date().toISOString();
      console.log(`📊 [${timestamp}] Fetching Supabase records - ONE TIME ONLY`);
      
      const response = await fetch('/api/supabase/get-all-transcriptions');
      const data = await response.json();

      if (data.success) {
        setSupabaseRecords(data.data || []);
        setLastSupabaseUpdate(new Date().toISOString());
        console.log(`✅ [${timestamp}] Loaded ${data.data?.length || 0} Supabase records`);
      } else {
        console.error('Failed to fetch Supabase records:', data.error);
      }
    } catch (err) {
      console.error('Error fetching Supabase records:', err);
    } finally {
      setLoadingSupabase(false);
    }
  };

  // NEW: Function to get calls that need processing (locally) with enhanced debugging
  const getCallsNeedingProcessing = useCallback((allCallLogs: CallLog[], allSupabaseRecords: SupabaseCallRecord[]) => {
    console.log(`\n🔍 === ANALYZING CALLS FOR PROCESSING ===`);
    console.log(`📊 Input: ${allCallLogs.length} call logs, ${allSupabaseRecords.length} Supabase records`);
    
    // Create a Set of contact IDs that exist in Supabase
    const supabaseContactIds = new Set(allSupabaseRecords.map(record => record.contact_id));
    console.log(`📋 Contact IDs in Supabase: ${supabaseContactIds.size}`);
    console.log(`📝 Sample Supabase contact IDs:`, Array.from(supabaseContactIds).slice(0, 5));
    
    // Filter call logs that need processing
    const needsProcessing = allCallLogs.filter(log => {
      // Must have recording location
      if (!log.recording_location) {
        return false;
      }
      
      // Must not exist in Supabase
      if (supabaseContactIds.has(log.contact_id)) {
        return false;
      }
      
      return true;
    });
    
    console.log(`🎯 RESULT: Found ${needsProcessing.length} calls that need processing`);
    
    if (needsProcessing.length > 0) {
      console.log(`📝 Sample contact IDs needing processing:`, needsProcessing.slice(0, 5).map(c => c.contact_id));
      console.log(`👥 Sample agents needing processing:`, needsProcessing.slice(0, 5).map(c => c.agent_username));
    } else {
      console.log(`✅ All calls already processed or missing recording locations`);
      
      // Debug why no calls need processing
      const noRecording = allCallLogs.filter(log => !log.recording_location).length;
      const alreadyExists = allCallLogs.filter(log => log.recording_location && supabaseContactIds.has(log.contact_id)).length;
      
      console.log(`📊 Breakdown:`);
      console.log(`   - No recording location: ${noRecording}`);
      console.log(`   - Already in Supabase: ${alreadyExists}`);
      console.log(`   - Total call logs: ${allCallLogs.length}`);
    }
    
    console.log(`🏁 === ANALYSIS COMPLETE ===\n`);
    return needsProcessing;
  }, []);

  // Merge call logs with Supabase records
  const mergedCallLogs = useMemo(() => {
    if (callLogs.length === 0) return [];

    const supabaseMap = new Map(supabaseRecords.map(record => [record.contact_id, record]));
    
    return callLogs.map(log => {
      const supabaseRecord = supabaseMap.get(log.contact_id);
      
      if (supabaseRecord) {
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
      } else {
        return {
          ...log,
          existsInSupabase: false,
          transcriptionStatus: "Pending Transcription" as const,
        };
      }
    });
  }, [callLogs, supabaseRecords]);

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

  // Calculate processing summary from merged data
  const calculatedSummary = useMemo(() => {
    const total = mergedCallLogs.length;
    const transcribed = mergedCallLogs.filter(log => log.existsInSupabase).length;
    const missing = mergedCallLogs.filter(log => !log.existsInSupabase && log.recording_location).length;
    
    return {
      totalCalls: total,
      existingTranscriptions: transcribed,
      missingTranscriptions: missing,
      processedThisRequest: autoProcessing.processed,
      errors: autoProcessing.failed
    };
  }, [mergedCallLogs, autoProcessing.processed, autoProcessing.failed]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Audio download function
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
    } else if (log.transcriptionStatus === "Processing" || autoProcessing.isRunning) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <div className="w-2 h-2 bg-yellow-500 rounded-full mr-1 animate-pulse"></div>
          Processing
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

  // NEW: Process a specific batch of calls directly (no API exclusion logic)
  const processSpecificBatch = async (batchCalls: CallLog[], batchNumber: number) => {
    console.log(`\n🚀 === PROCESSING BATCH ${batchNumber} ===`);
    console.log(`📋 Processing ${batchCalls.length} specific calls:`);
    batchCalls.forEach((call, idx) => {
      console.log(`   ${idx + 1}. ${call.contact_id} (${call.agent_username})`);
    });

    try {
      // Use the POST endpoint to process specific contact IDs
      const contactIds = batchCalls.map(call => call.contact_id);
      
      const response = await fetch('/api/process-calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contactIds: contactIds,
          processTranscriptions: true
        }),
      });

      const data = await response.json();

      if (data.success) {
        const processed = data.summary.processedThisRequest || 0;
        const errors = data.errors?.length || 0;

        console.log(`✅ Batch ${batchNumber} completed:`);
        console.log(`   - Processed: ${processed}/${batchCalls.length} calls`);
        console.log(`   - Errors: ${errors} calls`);

        // Handle processing errors
        if (data.errors && data.errors.length > 0) {
          setProcessingErrors(prev => [...prev, ...data.errors]);
        }

        // Update state
        setAutoProcessing(prev => ({
          ...prev,
          processed: prev.processed + processed,
          failed: prev.failed + errors,
          currentCallIndex: prev.currentCallIndex + batchCalls.length
        }));

        return { processed, errors };
      } else {
        console.error(`❌ Batch ${batchNumber} failed:`, data.error);
        setAutoProcessing(prev => ({
          ...prev,
          failed: prev.failed + batchCalls.length
        }));
        return { processed: 0, errors: batchCalls.length };
      }
    } catch (err) {
      console.error(`❌ Network error in batch ${batchNumber}:`, err);
      setAutoProcessing(prev => ({
        ...prev,
        failed: prev.failed + batchCalls.length
      }));
      return { processed: 0, errors: batchCalls.length };
    }
  };

  // NEW: Simple auto-process function that iterates through ALL calls with enhanced debugging
  const autoProcessAllTranscriptions = async () => {
    console.log(`\n🚀 === AUTO-PROCESSING STARTING ===`);
    
    // Check global processing state
    const globalProcessingActive = sessionStorage.getItem(GLOBAL_PROCESSING_KEY);
    if (globalProcessingActive || isAutoProcessingRunning.current) {
      console.log('🚫 Auto-processing already running, skipping...');
      console.log(`   - Global flag: ${globalProcessingActive}`);
      console.log(`   - Local flag: ${isAutoProcessingRunning.current}`);
      return;
    }

    console.log(`📊 Current data state:`);
    console.log(`   - Call logs: ${callLogs.length}`);
    console.log(`   - Supabase records: ${supabaseRecords.length}`);

    sessionStorage.setItem(GLOBAL_PROCESSING_KEY, Date.now().toString());
    isAutoProcessingRunning.current = true;

    // Get all calls that need processing
    const callsNeedingProcessing = getCallsNeedingProcessing(callLogs, supabaseRecords);
    
    if (callsNeedingProcessing.length === 0) {
      console.log('✅ No calls need processing - stopping auto-processing');
      sessionStorage.removeItem(GLOBAL_PROCESSING_KEY);
      isAutoProcessingRunning.current = false;
      return;
    }

    console.log(`🎯 PROCEEDING TO PROCESS ${callsNeedingProcessing.length} CALLS`);

    callsToProcess.current = callsNeedingProcessing;
    currentBatchIndex.current = 0;

    const totalBatches = Math.ceil(callsNeedingProcessing.length / BATCH_SIZE);
    
    console.log(`📋 Processing plan:`);
    console.log(`   - Total calls to process: ${callsNeedingProcessing.length}`);
    console.log(`   - Batch size: ${BATCH_SIZE}`);
    console.log(`   - Total batches: ${totalBatches}`);

    setAutoProcessing({
      isRunning: true,
      currentBatch: 0,
      totalBatches,
      processed: 0,
      failed: 0,
      remaining: callsNeedingProcessing.length,
      currentCallIndex: 0
    });

    setProcessing(true);
    setProcessingErrors([]);

    try {
      console.log(`🚀 STARTING BATCH PROCESSING...`);
      
      for (let batchNum = 1; batchNum <= totalBatches; batchNum++) {
        currentBatchIndex.current = batchNum;
        
        setAutoProcessing(prev => ({
          ...prev,
          currentBatch: batchNum
        }));

        // Get the next batch of calls
        const startIdx = (batchNum - 1) * BATCH_SIZE;
        const endIdx = Math.min(startIdx + BATCH_SIZE, callsNeedingProcessing.length);
        const batchCalls = callsNeedingProcessing.slice(startIdx, endIdx);

        console.log(`\n📊 BATCH ${batchNum}/${totalBatches}: Processing calls ${startIdx + 1}-${endIdx} of ${callsNeedingProcessing.length}`);

        const result = await processSpecificBatch(batchCalls, batchNum);

        // Update remaining count
        const remaining = callsNeedingProcessing.length - endIdx;
        setAutoProcessing(prev => ({
          ...prev,
          remaining: remaining
        }));

        console.log(`📊 Progress: ${endIdx}/${callsNeedingProcessing.length} calls processed, ${remaining} remaining`);

        // Wait between batches
        if (batchNum < totalBatches) {
          console.log(`⏸️ Waiting 5 seconds before next batch...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    } catch (error) {
      console.error('❌ Error in auto-processing:', error);
    } finally {
      setAutoProcessing(prev => ({
        ...prev,
        isRunning: false
      }));

      setProcessing(false);
      
      sessionStorage.removeItem(GLOBAL_PROCESSING_KEY);
      isAutoProcessingRunning.current = false;

      console.log(`\n🎉 === AUTO-PROCESSING COMPLETED ===`);
      console.log(`📊 Total calls processed: ${autoProcessing.processed}`);
      console.log(`❌ Total failures: ${autoProcessing.failed}`);
      
      // Clear refs
      callsToProcess.current = [];
      currentBatchIndex.current = 0;
      
      console.log(`🧹 Auto-processing session complete`);
    }
  };

  // Component cleanup
  useEffect(() => {
    return () => {
      if (isAutoProcessingRunning.current) {
        console.log('🧹 Component unmounting - clearing global processing flag');
        sessionStorage.removeItem(GLOBAL_PROCESSING_KEY);
      }
    };
  }, []);

  // Reset filters when data changes
  useEffect(() => {
    setSelectedAgent("all");
    setCurrentPage(1);
  }, [selectedDateRange]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedAgent, sortField, sortDirection]);

  // Fetch call logs
  useEffect(() => {
    const fetchCallLogs = async () => {
      if (!selectedDateRange) return;

      const dateRangeKey = `${selectedDateRange.start.toISOString()}-${selectedDateRange.end.toISOString()}`;

      if (isAutoProcessingRunning.current) {
        console.log('🚫 Skipping fetchCallLogs - auto-processing is currently running');
        return;
      }

      setLoading(true);
      setError(null);
      setProcessingSummary(null);
      setProcessingErrors([]);
      setAutoProcessing({
        isRunning: false,
        currentBatch: 0,
        totalBatches: 0,
        processed: 0,
        failed: 0,
        remaining: 0,
        currentCallIndex: 0
      });

      try {
        console.log('🔍 Step 1: Fetching Supabase records (ONE TIME ONLY)...');
        await fetchSupabaseRecords();

        console.log('📊 Step 2: Fetching call logs from database...');
        const params = new URLSearchParams({
          startDate: selectedDateRange.start.toISOString(),
          endDate: selectedDateRange.end.toISOString(),
          processTranscriptions: 'false',
        });

        const response = await fetch(`/api/process-calls?${params}`);
        const data = await response.json();

        if (data.success) {
          setCallLogs(data.data || []);
          console.log('📋 Call logs loaded:', data.summary);

          const shouldStartAutoProcessing = (
            autoProcessingInitiated.current !== dateRangeKey && 
            !isAutoProcessingRunning.current
          );
          
          if (shouldStartAutoProcessing) {
            autoProcessingInitiated.current = dateRangeKey;
            console.log(`🚀 Will start auto-processing after data loads...`);
            
            // Start auto-processing after a delay to ensure state is settled
            setTimeout(() => {
              if (!isAutoProcessingRunning.current) {
                autoProcessAllTranscriptions();
              }
            }, 2000);
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
  }, [selectedDateRange, checkSupabase, getCallsNeedingProcessing]);

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
              Supabase loaded: {new Date(lastSupabaseUpdate).toLocaleTimeString()}
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
                <span className="ml-2 text-xs text-yellow-400">🔄 Loading Supabase data...</span>
              )}
            </h6>
          </div>

          {/* Status Banner */}
          <div className="mb-4 p-2 bg-blue-900 border border-blue-600 rounded-lg">
            <div className="text-xs text-blue-300">
              📊 Simple approach: Load all data once, then process ALL calls that need transcription (no repeated checking)
              {isAutoProcessingRunning.current && (
                <span className="ml-2 text-yellow-400">(Currently processing)</span>
              )}
            </div>
          </div>

          {/* Auto-Processing Status */}
          {autoProcessing.isRunning && (
            <div className="mb-4 p-4 bg-blue-900 border border-blue-600 rounded-lg">
              <div className="text-sm text-blue-300 font-medium mb-2">
                🤖 Processing ALL Calls That Need Transcription
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs text-blue-200">
                <div>Batch: <span className="text-white font-medium">{autoProcessing.currentBatch}/{autoProcessing.totalBatches}</span></div>
                <div>Processed: <span className="text-green-400 font-medium">{autoProcessing.processed}</span></div>
                <div>Failed: <span className="text-red-400 font-medium">{autoProcessing.failed}</span></div>
                <div>Remaining: <span className="text-yellow-400 font-medium">{autoProcessing.remaining}</span></div>
                <div>Progress: <span className="text-blue-400 font-medium">{autoProcessing.currentCallIndex}/{callsToProcess.current.length}</span></div>
              </div>
              <div className="mt-2">
                <div className="w-full bg-blue-800 rounded-full h-2">
                  <div 
                    className="bg-blue-400 h-2 rounded-full transition-all duration-500" 
                    style={{ 
                      width: `${autoProcessing.totalBatches > 0 ? (autoProcessing.currentBatch / autoProcessing.totalBatches) * 100 : 0}%` 
                    }}
                  ></div>
                </div>
                <div className="text-xs text-blue-300 mt-1">
                  Processing {BATCH_SIZE} calls per batch - iterating through ALL calls that need transcription
                </div>
              </div>
            </div>
          )}

          {/* Enhanced Processing Summary */}
          <div className="mb-4 p-3 bg-bg-primary border border-border rounded-lg">
            <div className="text-sm text-[#4ecca3] font-medium mb-2">
              📊 Processing Summary
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs text-gray-300">
              <div>Total Calls: <span className="text-white font-medium">{calculatedSummary.totalCalls}</span></div>
              <div>Transcribed: <span className="text-green-400 font-medium">{calculatedSummary.existingTranscriptions}</span></div>
              <div>Missing: <span className="text-yellow-400 font-medium">{calculatedSummary.missingTranscriptions}</span></div>
              <div>Processed: <span className="text-blue-400 font-medium">{autoProcessing.processed}</span></div>
              <div>Errors: <span className="text-red-400 font-medium">{autoProcessing.failed}</span></div>
            </div>
            
            {calculatedSummary.missingTranscriptions > 0 && !autoProcessing.isRunning && (
              <div className="mt-3 flex items-center gap-2">
                <div className="text-xs text-green-400 font-medium">
                  🤖 Auto-processing will iterate through ALL calls that need transcription
                </div>
                <button
                  onClick={() => {
                    console.log('🔄 Manual auto-processing start requested by user');
                    console.log(`📊 Current state: ${callLogs.length} call logs, ${supabaseRecords.length} Supabase records`);
                    autoProcessAllTranscriptions();
                  }}
                  className="px-2 py-1 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700"
                >
                  🚀 Start Processing Now
                </button>
                <button
                  onClick={() => {
                    console.log('🔍 Manual analysis requested by user');
                    const needed = getCallsNeedingProcessing(callLogs, supabaseRecords);
                    console.log(`📊 Analysis result: ${needed.length} calls need processing`);
                  }}
                  className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
                >
                  🔍 Analyze Calls
                </button>
              </div>
            )}
          </div>

          {/* Processing Errors */}
          {processingErrors.length > 0 && (
            <div className="mb-4 p-3 bg-red-900 border border-red-600 rounded-lg">
              <div className="text-sm text-red-300 font-medium mb-2">
                ⚠️ Processing Errors ({processingErrors.length})
              </div>
              <div className="max-h-32 overflow-y-auto">
                {processingErrors.slice(0, 10).map((err, index) => (
                  <div key={index} className="text-xs text-red-200 mb-1">
                    <span className="font-mono">{err.contact_id}</span>: {err.error}
                  </div>
                ))}
                {processingErrors.length > 10 && (
                  <div className="text-xs text-red-300 mt-2">
                    ... and {processingErrors.length - 10} more errors
                  </div>
                )}
              </div>
            </div>
          )}

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

          {(processing || autoProcessing.isRunning) && (
            <div className="flex items-center justify-center p-4 mb-4 bg-yellow-900 border border-yellow-600 rounded-lg">
              <div className="text-yellow-200">
                {autoProcessing.isRunning 
                  ? `🤖 Processing batch ${autoProcessing.currentBatch}/${autoProcessing.totalBatches} - Call ${autoProcessing.currentCallIndex}/${callsToProcess.current.length}` 
                  : '🚀 Starting transcription processing...'
                }
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
              Error: {error}
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