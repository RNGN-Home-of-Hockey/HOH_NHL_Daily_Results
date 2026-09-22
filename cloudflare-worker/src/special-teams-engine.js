// Special Teams Engine

export function buildSpecialTeamsAnalytics(team={}){
 const pp=Number(team.pp||0);
 const pk=Number(team.pk||0);
 const discipline=Number(team.penalties||0);
 return {
  model:"special_teams_v1",
  power_play:pp,
  penalty_kill:pk,
  discipline,
  special_score:Math.round(pp*0.5+pk*0.5-Math.max(0,discipline-3)*2)
 };
}
