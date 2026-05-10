import prices from './api/prices/index.js';

async function test() {
  const tests = [
    { time: '2026-05-10T11:59:00Z', label: 'Before 14:05 (13:59)' },
    { time: '2026-05-10T12:06:00Z', label: 'After 14:05 (14:06)' }
  ];

  for (const t of tests) {
    let capturedUrl = '';
    
    // Mock global fetch
    global.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        text: async () => JSON.stringify({ data: [] })
      };
    };

    // Mock global Date
    const originalDate = Date;
    global.Date = class extends originalDate {
      constructor(arg) {
        if (arg) {
           return new originalDate(arg);
        }
        return new originalDate(t.time);
      }
    };
    global.Date.now = () => new originalDate(t.time).getTime();

    const context = {
        res: {},
        log: { error: console.error }
    };
    const req = { query: {} };

    await prices(context, req);

    console.log(`Test: ${t.label}`);
    console.log(`Time: ${t.time}`);
    console.log(`URL: ${capturedUrl}`);
    console.log('---');

    // Reset Date for next iteration
    global.Date = originalDate;
  }
}

test().catch(console.error);
