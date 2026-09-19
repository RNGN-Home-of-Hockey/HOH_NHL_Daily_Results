// Single source of truth for the HOME OF HOCKEY × WINLINE broadcast card.
// Geometry is locked to the supplied 820×211 template asset. Both preview and OBS
// overlay consume this exact CSS so the card cannot drift between surfaces.
export const BROADCAST_CARD_CSS = String.raw`
@font-face{
  font-family:"Sofia Sans Condensed HOH";
  src:url("/broadcast/sofia-sans-condensed-italic.woff2?v=1") format("woff2");
  font-style:italic;
  font-weight:100 1000;
  font-display:block;
}
.hohcard{
  position:relative;
  width:min(820px,100%);
  aspect-ratio:820/211;
  margin:0 auto;
  overflow:hidden;
  container-type:inline-size;
  background:url("/broadcast/card-template.webp?v=1") center/100% 100% no-repeat;
  color:#fff;
  isolation:isolate;
}
.hohcard,.hohcard *{
  box-sizing:border-box;
  font-family:"Sofia Sans Condensed HOH";
  font-style:italic;
  font-synthesis:none;
  text-transform:uppercase;
}
.hohcard-fact{
  position:absolute;
  left:5.35%;
  top:5.1%;
  width:88.4%;
  height:25.2%;
  display:flex;
  align-items:center;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
  font-size:2.45cqw;
  line-height:.94;
  font-weight:900;
  letter-spacing:.01em;
  padding-right:1.4%;
}
.hohcard-fact .facthot{color:#ff641e}
.hohcard-teammark{
  position:absolute;
  left:1.7%;
  top:39.0%;
  width:14.8%;
  height:54.0%;
  display:grid;
  place-items:center;
  overflow:hidden;
}
.hohcard-teammark img{
  display:block;
  width:72%;
  height:72%;
  object-fit:contain;
}
.hohcard-teammark span{
  font-size:3.0cqw;
  line-height:1;
  font-weight:900;
  color:#d7d7db;
}
.hohcard-team{
  position:absolute;
  left:18.7%;
  top:45.0%;
  width:28.7%;
  height:16.5%;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
  font-size:4.05cqw;
  line-height:.95;
  font-weight:900;
  letter-spacing:.005em;
}
.hohcard-market{
  position:absolute;
  left:18.7%;
  top:63.8%;
  width:28.7%;
  height:14.5%;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
  color:#d6d6da;
  font-size:2.22cqw;
  line-height:1;
  font-weight:850;
  letter-spacing:.015em;
}
.hohcard-odds{
  position:absolute;
  left:80.0%;
  top:39.3%;
  width:16.6%;
  height:32.0%;
  display:flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  white-space:nowrap;
  font-size:5.85cqw;
  line-height:.9;
  font-weight:900;
  letter-spacing:-.035em;
  padding-left:1.2%;
}
.hohcard-profit{
  position:absolute;
  left:53.0%;
  top:77.4%;
  width:42.2%;
  height:19.2%;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:1.15cqw;
  overflow:hidden;
  white-space:nowrap;
  padding:0 1.5%;
}
.hohcard-profit strong{
  color:#ff641e;
  font-size:2.62cqw;
  line-height:1;
  font-weight:900;
  white-space:nowrap;
}
.hohcard-profit span{
  color:#d4d4d8;
  font-size:1.42cqw;
  line-height:1;
  font-weight:850;
  white-space:nowrap;
}
.hohcard-unpriced .hohcard-odds{font-size:4.5cqw}
@media(max-width:520px){
  .hohcard-fact{font-size:2.7cqw}
  .hohcard-team{font-size:4.25cqw}
  .hohcard-market{font-size:2.35cqw}
}
`;
