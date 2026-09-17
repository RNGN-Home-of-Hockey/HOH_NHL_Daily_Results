import { runVkBroadcastMaintenance as runLegacyVkBroadcastMaintenance } from "./telegram-center-vk-maintenance.js";
import { resolveVkAccessToken } from "./telegram-center-vk-auth.js";

export async function runVkBroadcastMaintenance(env,options={}){
  let token;
  try{
    token=await resolveVkAccessToken(env);
  }catch(error){
    return {ok:false,error:String(error?.message||error||"vk_auth_failed")};
  }
  let result=await runLegacyVkBroadcastMaintenance({DB:env.DB,VK_ACCESS_TOKEN:token},options);
  if(!result?.ok&&/VK video\.get 5:|authorization failed/i.test(String(result?.error||""))){
    try{
      token=await resolveVkAccessToken(env,{force:true});
      result=await runLegacyVkBroadcastMaintenance({DB:env.DB,VK_ACCESS_TOKEN:token},options);
    }catch(error){
      return {ok:false,error:String(error?.message||error||"vk_refresh_failed")};
    }
  }
  return result;
}
