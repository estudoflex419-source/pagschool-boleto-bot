const courses = require("./courses")
const {normalize} = require("../utils/text")

function detectCourse(text){
  const t = normalize(text)

  for(const c of courses){
    if(t.includes(normalize(c))){
      return c
    }
  }

  return null
}

function detectClose(text){
  const t = normalize(text)
  return /(quero|sim|fazer|gostei|posso|bora)/.test(t)
}

function menu(){
  return `Olá 👋
Seja bem-vindo à Estudo Flex.

🔎 Quero nova matrícula
💳 Já sou aluno
📚 Conhecer cursos`
}

function showCourses(){
  return `Temos cursos como:

${courses.map((c)=>`- ${c}`).join("\n")}

Qual deles chama sua atenção?`
}

function price(course){
  return `Perfeito 😊

Sobre ${course}:

💰 Custa 12x de 80
📄 Boleto
💳 Cartão

Quer garantir sua vaga?`
}

module.exports={
  detectCourse,
  detectClose,
  menu,
  showCourses,
  price
}
