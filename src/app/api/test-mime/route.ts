// Create this as: app/api/test-mime/route.ts
// This endpoint helps test MIME type handling

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const testFile = searchParams.get('file') || 'test_UTC.wav';
  
  try {
    console.log(`🧪 Testing MIME type for: ${testFile}`);
    
    // Test our SFTP endpoint
    const baseUrl = process.env.NETWORK_URL || 'http://192.168.40.101:3000';
    const sftpUrl = `${baseUrl}/api/sftp/download?filename=${encodeURIComponent(testFile)}`;
    
    console.log(`🧪 Testing SFTP URL: ${sftpUrl}`);
    
    const response = await fetch(sftpUrl, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(10000)
    });
    
    const headers = Object.fromEntries(response.headers.entries());
    
    console.log(`🧪 SFTP Response:`, {
      status: response.status,
      headers: headers
    });
    
    return NextResponse.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headers,
      sftpUrl: sftpUrl,
      testFile: testFile,
      contentType: headers['content-type'],
      contentLength: headers['content-length'],
      isAudioMimeType: headers['content-type']?.startsWith('audio/'),
    });
    
  } catch (error) {
    console.error(`🧪 Test failed:`, error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      testFile: testFile,
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { filename } = await request.json();
    
    if (!filename) {
      return NextResponse.json({ error: 'filename required' }, { status: 400 });
    }
    
    console.log(`🧪 Testing full download for: ${filename}`);
    
    // Test actual download
    const baseUrl = process.env.NETWORK_URL || 'http://192.168.40.101:3000';
    const sftpUrl = `${baseUrl}/api/sftp/download?filename=${encodeURIComponent(filename)}`;
    
    const response = await fetch(sftpUrl, {
      signal: AbortSignal.timeout(30000) // 30 seconds
    });
    
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    
    const blob = await response.blob();
    const headers = Object.fromEntries(response.headers.entries());
    
    // Test what AssemblyAI would see
    const formData = new FormData();
    formData.append('file', blob, filename.split('/').pop());
    
    console.log(`🧪 Download successful:`, {
      blobSize: blob.size,
      blobType: blob.type,
      serverHeaders: headers,
      filename: filename
    });
    
    return NextResponse.json({
      success: true,
      downloadTest: {
        status: response.status,
        headers: headers,
        blobSize: blob.size,
        blobType: blob.type,
        sizeInMB: (blob.size / (1024 * 1024)).toFixed(2),
      },
      assemblyAITest: {
        formDataBlobType: blob.type,
        filename: filename.split('/').pop(),
        wouldPassMimeCheck: blob.type.startsWith('audio/') || headers['content-type']?.startsWith('audio/'),
      }
    });
    
  } catch (error) {
    console.error(`🧪 Full test failed:`, error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}