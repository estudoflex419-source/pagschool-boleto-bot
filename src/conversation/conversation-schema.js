"use strict";

function createDefaultConversation() {
  return {
    step: "menu",
    path: "",
    course: "",
    goal: "",
    experience: "",
    payment: "",
    paymentTeaserShown: false,
    commercialStage: "discovery",
    priceShown: false,
    enrollmentIntent: false,
    objectiveCapturedAt: "",
    askToCloseCount: 0,
    lastQuestionKey: "",
    lastOfferSignature: "",
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
    internalLeadNotifyKey: "",
    lastUserText: "",
    lastAssistantText: "",
    lastStepWhenAnswered: "",
  };
}

module.exports = {
  createDefaultConversation,
};
