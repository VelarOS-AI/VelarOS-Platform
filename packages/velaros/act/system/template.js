import {output} from 'velaros';
import {modules,memory} from 'velaros:system';
const usage=await modules.describe({module:'velaros:system',export:'memory'});
output(usage.template,{type:'code'});
output(await memory.list({kind:'notes'}));
