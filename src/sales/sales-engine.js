"use strict";

function createSalesEngine({
  detectCloseMoment,
  detectPriceObjection,
  recommendCoursesByGoal,
} = {}) {
  function nextAction({ text, lead, catalogCourses = [] }) {
    const safeLead = lead || {};

    if (detectCloseMoment && detectCloseMoment(text)) {
      return {
        type: "collecting_enrollment",
        stage: "collecting_enrollment",
        message: "Perfeito. Vamos para sua matricula. Me envie nome completo, curso e forma de pagamento.",
      };
    }

    if (detectPriceObjection && detectPriceObjection(text)) {
      return {
        type: "price_objection",
        stage: safeLead.stage || "proposal",
        message:
          "Entendo. Podemos avaliar entrada para reduzir parcelas. Com entrada de R$100 reduz 2 parcelas e com R$50 reduz 1.",
      };
    }

    if (!safeLead.course && recommendCoursesByGoal) {
      const rec = recommendCoursesByGoal(text, catalogCourses);
      if (rec) {
        return {
          type: "goal_recommendation",
          stage: safeLead.stage || "discovering",
          recommendation: rec,
        };
      }
    }

    return {
      type: "continue",
      stage: safeLead.stage || "discovering",
    };
  }

  return { nextAction };
}

module.exports = {
  createSalesEngine,
};

