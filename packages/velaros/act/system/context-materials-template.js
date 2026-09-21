import {output} from 'velaros'
import {list,read} from 'velaros:context-materials'
async function inspect(){
 const page=await list({limit:16})
 output(page)
 if(page.items.length)output(await read({ref:page.items[0].ref,limit:12000}))
}
