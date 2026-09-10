// User descriptions, not diagnoses or treatment indications.
const aliases = [
  ['松弛', /(?:脸|面部|轮廓|皮肤)[^，。！？；]{0,8}(?:垮|松垮|松松的)|(?:嘴边肉|肉往下掉|脸往下掉)/g],
  ['凹陷', /凹陷|(?:脸|面部|太阳穴|脸颊)[^，。！？；]{0,6}(?:凹|瘪)|不饱满/g],
  ['暗沉', /(?:脸|肤色|皮肤)[^，。！？；]{0,6}(?:没光泽|灰扑扑|蜡黄)/g],
  ['疲惫感', /(?:脸|面部|看着|看起来|显得)[^，。！？；]{0,6}(?:疲惫|很累|没精神)/g]
];
const negated = (text, index) => /(?:不是|并非|没有|不觉得|不是说|不在意)[^，。！？；]{0,8}$/.test(text.slice(Math.max(0,index-14),index));
export function understandConcern(message, terms = []) {
  const text=String(message||'').replace(/而是|但是|只是/g,'，');
  const found=new Set(), denied=new Set();
  for(const term of terms){
    for(let i=text.indexOf(term);i>=0;i=text.indexOf(term,i+term.length)) (negated(text,i)?denied:found).add(term);
  }
  for(const [canonical,pattern] of aliases){
    for(const hit of text.matchAll(pattern)) (negated(text,hit.index)||/不是|没有/.test(hit[0])?denied:found).add(canonical);
  }
  const facial=/(?:脸|面部|轮廓|嘴边肉|太阳穴|脸颊)/.test(text);
  return {concerns:[...found].filter(x=>!denied.has(x)),negated_concerns:[...denied],facial,
    ambiguous_appearance:facial && /垮|没精神|疲惫|很累/.test(text) && !/嘴边肉|下垂|松弛|凹陷|往下掉/.test(text) && !denied.size,
    non_surgical_preference:/(?:不想|不要|不考虑|不接受)[^，。！？；]{0,4}(?:动刀|手术|开刀)/.test(text)};
}
