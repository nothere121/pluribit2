// clear_reorg_marker.js
import { Level } from 'level';
import path from 'path';

const DB_PATH = path.resolve(process.cwd(), 'pluribit-data');
const metaDb = new Level(path.join(DB_PATH, 'meta'), { valueEncoding: 'json' });

await metaDb.open();
try {
    await metaDb.del('reorg_in_progress');
    console.log('Reorg marker cleared successfully');
} catch (e) {
    if (e.code === 'LEVEL_NOT_FOUND') {
        console.log('No reorg marker found');
    } else {
        console.error('Error:', e);
    }
}
await metaDb.close();
