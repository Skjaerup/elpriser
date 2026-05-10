import handler from './api/prices/index.js';

const RealDate = Date;
const fixedDate = new RealDate('2026-05-10T12:06:00Z');

global.fetch = async (url) => {
    console.log('FETCH_URL=' + url);
    return {
        status: 200,
        ok: true,
        json: async () => ({ records: [] })
    };
};

global.Date = class extends RealDate {
    constructor(arg) {
        if (arg === undefined) return fixedDate;
        return new RealDate(arg);
    }
    static now() {
        return fixedDate.getTime();
    }
};

const req = { query: {} };
const res = {
    setHeader: (name, value) => {
        console.log('HEADER_' + name + '=' + value);
    },
    status: (code) => {
        console.log('STATUS=' + code);
        return {
            json: (data) => {
                console.log('JSON_RESPONSE_RECEIVED');
            }
        };
    }
};

async function run() {
    try {
        await handler(req, res);
    } catch (err) {
        console.error('ERROR=' + err.message);
        console.error(err.stack);
    }
}

run();
