const FEMININE_TEAMS = new Set(["ARI","CAR","FLA","MIN","OTT","PHI","TBL","UTA"]);
const PLURAL_TEAMS = new Set(["NYI","NYR"]);

const WORD_FORMS = {
  "закрыл": { m:"закрыл", f:"закрыла", pl:"закрыли" },
  "забил": { m:"забил", f:"забила", pl:"забили" },
  "забивал": { m:"забивал", f:"забивала", pl:"забивали" },
  "остался": { m:"остался", f:"осталась", pl:"остались" },
  "пропускал": { m:"пропускал", f:"пропускала", pl:"пропускали" },
  "открывал": { m:"открывал", f:"открывала", pl:"открывали" },
  "выиграл": { m:"выиграл", f:"выиграла", pl:"выиграли" },
  "проиграл": { m:"проиграл", f:"проиграла", pl:"проиграли" },
};
const FIRST_FORMS = { m:"первым", f:"первой", pl:"первыми" };

export function teamGrammar(team){
  const tri=String(team||"").toUpperCase();
  if(PLURAL_TEAMS.has(tri)) return "pl";
  if(FEMININE_TEAMS.has(tri)) return "f";
  return "m";
}

export function lastGamesPhrase(n){
  const value=Math.max(0,Math.trunc(Number(n)||0));
  const mod10=value%10,mod100=value%100;
  if(mod10===1&&mod100!==11) return `последнего ${value} матча`;
  return `последних ${value} матчей`;
}

export function applyTeamGrammar(text){
  let out=String(text??"");
  const teams=new Set([...FEMININE_TEAMS,...PLURAL_TEAMS]);
  for(const match of out.matchAll(/\b[A-Z]{3}\b/g)) teams.add(match[0]);
  for(const tri of teams) out=fixSubject(out,tri,tri);
  return out;
}

export function applyDisplayTeamGrammar(text,team,displayName){
  return fixSubject(String(text??""),String(displayName||""),String(team||"").toUpperCase());
}

function fixSubject(text,subject,team){
  if(!subject) return text;
  const escaped=escapeRegExp(subject);
  const form=teamGrammar(team);
  const firstRe=new RegExp(`(${escaped}\\s+)(пропускал)\\s+(первым)\\b`,"gi");
  text=text.replace(firstRe,(all,prefix,verb,first)=>prefix+caseLike(verb,WORD_FORMS["пропускал"][form])+" "+caseLike(first,FIRST_FORMS[form]));
  const re=new RegExp(`(${escaped}\\s+(?:(?:дома|в\\s+гостях)\\s+)?(?:не\\s+)?)(закрыл|забил|забивал|остался|пропускал|открывал|выиграл|проиграл)\\b`,"gi");
  return text.replace(re,(all,prefix,word)=>{
    const forms=WORD_FORMS[String(word).toLowerCase()];
    return prefix+caseLike(word,forms?.[form]||word);
  });
}

function escapeRegExp(value){
  return String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
}

function caseLike(source,replacement){
  const s=String(source||"");
  if(s===s.toUpperCase()) return String(replacement).toUpperCase();
  if(s[0]&&s[0]===s[0].toUpperCase()) return replacement[0].toUpperCase()+replacement.slice(1);
  return replacement;
}
