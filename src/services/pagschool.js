const axios = require("axios")
const {PAGSCHOOL_URL,PAGSCHOOL_EMAIL,PAGSCHOOL_PASSWORD} = require("../config")

let tokenCache=null

async function login(){
  if(tokenCache) return tokenCache

  const r = await axios.post(
    `${PAGSCHOOL_URL}/auth/authenticate`,
    {
      email:PAGSCHOOL_EMAIL,
      password:PAGSCHOOL_PASSWORD
    }
  )

  tokenCache=r.data.token

  return tokenCache
}

async function buscarAluno(cpf){
  const token = await login()

  const r = await axios.get(
    `${PAGSCHOOL_URL}/alunos?cpf=${cpf}`,
    {
      headers:{Authorization:`JWT ${token}`}
    }
  )

  return r.data
}

module.exports={buscarAluno}
