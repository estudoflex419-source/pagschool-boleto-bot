function normalize(text){
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
}

function isCPF(text){
  return /\d{11}/.test(text)
}

module.exports={normalize,isCPF}
