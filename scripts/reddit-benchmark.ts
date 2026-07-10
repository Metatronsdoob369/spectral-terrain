import { performance } from 'perf_hooks';

const SERVER_URL = 'http://localhost:3000'; // Adjust to 3001 if your server bound to 3001
const TEST_DOMAIN = 'reddit';

interface TestCase {
  name:    string;
  path:    string;
  headers: Record<string, string>;
  body:    string;
  isThreat: boolean;
}

const testSuite: TestCase[] = [
  {
    name: '1. Benign Reddit Post fetch',
    path: '/api/v1/reddit/posts?limit=10',
    headers: {
      'X-Threat-Domain': TEST_DOMAIN,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    },
    body: '',
    isThreat: false
  },
  {
    name: '2. Suspicious Host Spoofing',
    path: '/api/v1/reddit/posts',
    headers: {
      'X-Threat-Domain': TEST_DOMAIN,
      'Host': 'rogue-attacker.com',
      'User-Agent': 'curl/8.7.1'
    },
    body: 'username=joewales',
    isThreat: true
  },
  {
    name: '3. Multipart SQL Injection Injection',
    path: '/api/v1/reddit/comments',
    headers: {
      'X-Threat-Domain': TEST_DOMAIN,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'comment=1\' OR \'1\'=\'1\' --&author=attacker',
    isThreat: true
  },
  {
    name: '4. Path Traversal File Mock',
    path: '/api/v1/reddit/upload',
    headers: {
      'X-Threat-Domain': TEST_DOMAIN,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'filename=../../etc/passwd',
    isThreat: true
  }
];

async function runBenchmark() {
  console.log(`\n==================================================================`);
  console.log(`🚀 STARTING GEOMETRIC TELEMETRY BENCHMARK`);
  console.log(`   Target: ${SERVER_URL} | Domain: ${TEST_DOMAIN}`);
  console.log(`==================================================================\n`);

  console.log(`Checking connection to server...`);
  try {
    const check = await fetch(SERVER_URL);
    if (!check.ok) throw new Error();
    console.log(`✅ Connection established successfully.\n`);
  } catch {
    console.error(`❌ Could not connect to the server at ${SERVER_URL}.`);
    console.error(`   Please run 'npx tsx scripts/curl-lab-server.ts' in a separate terminal tab first.`);
    process.exit(1);
  }

  const results: any[] = [];

  for (const test of testSuite) {
    console.log(`Executing test: ${test.name}...`);
    
    const tStart = performance.now();
    
    try {
      const init: RequestInit = {
        method: test.body ? 'POST' : 'GET',
        headers: test.headers
      };
      
      if (test.body) {
        init.body = test.body;
      }
      
      const res = await fetch(`${SERVER_URL}${test.path}`, init);
      const tEnd = performance.now();
      const rtt = tEnd - tStart;
      
      const resJson = await res.json() as any;

      // Extract custom threat evaluation headers from response
      const shatterHeader = res.headers.get('X-Shatter-Score') || '0.0000';
      const classHeader = res.headers.get('X-Threat-Classification') || 'UNKNOWN';
      const pipelineTimeHeader = res.headers.get('X-Pipeline-Time-Ms') || '—';

      results.push({
        name: test.name,
        path: test.path,
        expectedThreat: test.isThreat ? 'YES' : 'NO',
        shatter: parseFloat(shatterHeader).toFixed(4),
        classification: classHeader,
        clientRttMs: `${rtt.toFixed(2)} ms`,
        serverPipelineMs: pipelineTimeHeader !== '—' ? `${parseFloat(pipelineTimeHeader).toFixed(2)} ms` : '—'
      });
      
    } catch (err: any) {
      results.push({
        name: test.name,
        path: test.path,
        expectedThreat: test.isThreat ? 'YES' : 'NO',
        shatter: 'ERROR',
        classification: 'FAILED',
        clientRttMs: '—',
        serverPipelineMs: '—',
        error: err.message
      });
    }
  }

  console.log(`\n========================================================================================`);
  console.log(`🏆 LATENCY & DETECTION BENCHMARK REPORT`);
  console.log(`========================================================================================`);
  console.table(results.map(r => ({
    'Test Case': r.name,
    'Path': r.path,
    'Exp Threat': r.expectedThreat,
    'Shatter Score': r.shatter,
    'Classification': r.classification,
    'Client Roundtrip': r.clientRttMs,
    'Engine Processing': r.serverPipelineMs
  })));
  console.log(`========================================================================================`);
  console.log(`💡 NOTE:`);
  console.log(`   - 'Engine Processing' is the duration of embedding generation and distance scoring.`);
  console.log(`   - 'Client Roundtrip' is total network time. The delta is connection/transmission overhead.`);
  console.log(`   - If Engine Processing is under 20-60ms, the local model is performing at native speed.`);
  console.log(`========================================================================================\n`);
}

runBenchmark();
