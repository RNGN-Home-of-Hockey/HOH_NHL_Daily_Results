// AIR SCORE Calibration Engine
// Keeps editorial score separate from outcome probability.

export function calibrateAirScore(samples=[]){
 const usable=samples.filter(x=>Number.isFinite(Number(x.air_score))&&x.result!==undefined);
 if(!usable.length)return {sample:0};
 const buckets={};
 for(const x of usable){
  const bucket=Math.floor(Number(x.air_score)/10)*10;
  if(!buckets[bucket])buckets[bucket]={count:0,hits:0};
  buckets[bucket].count++;
  if(x.result===true||x.result==="win")buckets[bucket].hits++;
 }
 for(const b of Object.values(buckets)) b.hit_rate=b.count?b.hits/b.count:0;
 return {sample:usable.length,buckets};
}
