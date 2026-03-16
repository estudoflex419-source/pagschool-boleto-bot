const conversations = new Map()

function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
      step: "menu",
      path: "",
      course: "",
      goal: "",
      experience: "",
      payment: "",
      name: "",
      cpf: "",
      birthDate: "",
      gender: "",
      phone: "",
      cep: "",
      street: "",
      number: "",
      complement: "",
      neighborhood: "",
      city: "",
      state: "",
      dueDay: "",
      alunoId: null,
      contratoId: null,
      parcelaId: null,
      nossoNumero: ""
    })
  }

  return conversations.get(phone)
}

module.exports = { getConversation }
