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
      paymentTeaserShown: false,
      name: "",
      cpf: "",
      birthDate: "",
      email: "",
      gender: "",
      phone: "",
      cep: "",
      street: "",
      number: "",
      complement: "",
      neighborhood: "",
      city: "",
      state: "",
      deferredPaymentDay: "",
      dueDay: "",
      alunoId: null,
      contratoId: null,
      parcelaId: null,
      nossoNumero: "",
      internalLeadNotified: false,
      internalLeadNotifiedAt: "",
      internalLeadNotifyKey: ""
    })
  }

  return conversations.get(phone)
}

module.exports = { getConversation }


module.exports = { getConversation }
