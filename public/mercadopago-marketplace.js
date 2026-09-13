/* Painel exclusivo da conta marketplace. Valores remotos usam textContent. */
window.mountMercadoPagoMarketplace = async function (root, api) {
  root.className = "mp-marketplace";
  const money = value => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const text = (parent, tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className; parent.append(node); return node;
  };
  const loading = text(root, "div", "Sincronizando dados operacionais…", "mp-loading");
  loading.setAttribute("role", "status");

  const configCard = (label, value, ready, detail) => {
    const card = document.createElement("article"); card.className = `mp-config-card ${ready ? "is-ready" : "is-pending"}`;
    const top = document.createElement("div"); top.className = "mp-config-top";
    text(top, "span", ready ? "●" : "!", "mp-config-icon");
    text(top, "span", ready ? "OPERACIONAL" : "ATENÇÃO", "mp-state-pill"); card.append(top);
    text(card, "span", label, "mp-config-label"); text(card, "strong", value, "mp-config-value");
    text(card, "small", detail, "mp-config-detail"); return card;
  };

  async function render() {
    try {
      const [data, commissions] = await Promise.all([
        api("/api/platform/payments/mercadopago/status"),
        api("/api/platform/payments/mercadopago/commissions?limit=100"),
      ]);
      root.replaceChildren();
      const ready = data.applicationConfigured && data.oauthConfigured && data.webhookConfigured;
      const head = document.createElement("header"); head.className = "mp-head";
      const copy = document.createElement("div"); text(copy, "span", "MERCADO PAGO · MARKETPLACE", "mp-kicker");
      text(copy, "h2", "Centro de operações financeiras");
      text(copy, "p", "Configuração, conectividade e conciliação dos pagamentos em uma única visão.", "muted");
      text(head, "span", ready ? "● SISTEMA OPERACIONAL" : "● CONFIGURAÇÃO PENDENTE", `mp-overall ${ready ? "online" : "warning"}`);
      head.prepend(copy); root.append(head);

      const sectionHead = document.createElement("div"); sectionHead.className = "mp-section-head";
      const sectionCopy = document.createElement("div"); text(sectionCopy, "h3", "Configuração da plataforma");
      text(sectionCopy, "p", "Credenciais e canais necessários para operar o marketplace.", "muted");
      const actions = document.createElement("div"); actions.className = "mp-section-actions";
      const feedback = text(actions, "span", "", "mp-feedback"); feedback.setAttribute("role", "status");
      const verify = text(actions, "button", "Verificar conta", "mp-verify"); verify.type = "button"; verify.disabled = !data.platformTokenConfigured;
      verify.onclick = async () => { verify.disabled = true; feedback.textContent = "Consultando Mercado Pago…";
        try { const result = await api("/api/platform/payments/mercadopago/verify", { method: "POST" }); feedback.textContent = `Conta ${result.accountId} verificada.`; await render(); }
        catch (error) { feedback.textContent = error.message; verify.disabled = false; }
      };
      sectionHead.append(sectionCopy, actions); root.append(sectionHead);

      const grid = document.createElement("section"); grid.className = "mp-config-grid";
      const account = data.marketplaceAccount;
      grid.append(
        configCard("Conta marketplace", account ? `${account.accountId} · ${account.country || "-"}` : "Não verificada", !!account, account?.testAccount ? "Ambiente de teste" : "Conta da plataforma"),
        configCard("Aplicação", data.applicationConfigured ? "Configurada" : "Pendente", data.applicationConfigured, data.appId || "App ID ausente"),
        configCard("Access Token", data.platformTokenConfigured ? "Disponível" : "Pendente", data.platformTokenConfigured, "Credencial da plataforma"),
        configCard("Public Key", data.publicKeyConfigured ? "Disponível" : "Pendente", data.publicKeyConfigured, "Checkout transparente"),
        configCard("Criptografia OAuth", data.encryptionConfigured ? "Protegida" : "Pendente", data.encryptionConfigured, "Tokens dos organizadores"),
        configCard("OAuth", data.oauthConfigured ? "Configurado" : "Pendente", data.oauthConfigured, "Autorização de vendedores"),
        configCard("Webhook", data.webhookConfigured ? "Monitorado" : "Pendente", data.webhookConfigured, "Notificações de pagamento"),
        configCard("Comissão AppRifa", `${Number(data.marketplaceFeePercent).toLocaleString("pt-BR")}%`, Number(data.marketplaceFeePercent) > 0, "Percentual por pagamento"),
        configCard("Organizadores", String(data.connectedSellers), data.connectedSellers > 0, "Contas conectadas")
      ); root.append(grid);

      const endpoints = document.createElement("div"); endpoints.className = "mp-endpoints";
      text(endpoints, "span", "ENDPOINTS", "mp-endpoint-title");
      text(endpoints, "code", `OAuth  ${data.redirectUri || "não configurada"}`);
      text(endpoints, "code", `Webhook  ${data.notificationUrl || "não configurada"}`); root.append(endpoints);

      const noc = document.createElement("section"); noc.className = "mp-noc";
      const nocHead = document.createElement("div"); nocHead.className = "mp-noc-head";
      const nocCopy = document.createElement("div"); text(nocCopy, "span", "NOC FINANCEIRO", "mp-noc-kicker"); text(nocCopy, "h3", "Conciliação em tempo real");
      text(nocHead, "span", data.lastWebhook ? "● WEBHOOK ATIVO" : "● SEM TELEMETRIA", `mp-noc-status ${data.lastWebhook ? "online" : "warning"}`); nocHead.prepend(nocCopy); noc.append(nocHead);
      const metrics = document.createElement("div"); metrics.className = "mp-metrics";
      const entries = [
        ["Volume processado", money(data.reconciliation.grossAmount), `${data.reconciliation.payments} pagamentos`, "primary"],
        ["Receita AppRifa", money(data.reconciliation.marketplaceFeeAmount), "Comissão solicitada", "success"],
        ["Taxas Mercado Pago", money(data.reconciliation.mercadoPagoFeeAmount), "Valores identificados", "neutral"],
        ["Líquido organizadores", money(data.reconciliation.sellerNetAmount), "Valores identificados", "neutral"],
        ["Pendências", String(data.reconciliation.pending), data.reconciliation.pending ? "Requer análise" : "Fila normalizada", data.reconciliation.pending ? "danger" : "success"]
      ];
      for (const [label, value, detail, tone] of entries) { const card = document.createElement("article"); card.className = `mp-metric ${tone}`; text(card,"span",label); text(card,"strong",value); text(card,"small",detail); metrics.append(card); } noc.append(metrics);
      const telemetry = document.createElement("div"); telemetry.className = "mp-telemetry"; text(telemetry,"span","ÚLTIMO EVENTO DE WEBHOOK");
      text(telemetry,"strong",data.lastWebhook ? `${data.lastWebhook.status} · ${new Date(data.lastWebhook.createdAt).toLocaleString("pt-BR")}` : "Nenhum evento recebido"); noc.append(telemetry);
      const tableHead = document.createElement("div"); tableHead.className = "mp-table-head"; text(tableHead,"h3","Fluxo de pagamentos"); text(tableHead,"span",`${commissions.length} registros recentes`,"mp-table-count"); noc.append(tableHead);
      const wrap = document.createElement("div"); wrap.className = "mp-table-wrap"; const table = document.createElement("table"); table.className = "mp-table";
      const header = document.createElement("tr"); ["Pagamento","Organizador","Cobrado","Comissão","Taxa MP","Líquido","Situação","Data"].forEach(v=>text(header,"th",v)); const thead=document.createElement("thead"); thead.append(header); const tbody=document.createElement("tbody");
      commissions.forEach(payment => { const row=document.createElement("tr"); const status=payment.financialStatus||payment.status||"pendente";
        [payment.externalId||`local ${payment.id}`,payment.Tenant?.name||"-",money(payment.amount),money(payment.marketplaceFeeAmount),payment.mercadoPagoFeeAmount==null?"Pendente":money(payment.mercadoPagoFeeAmount),payment.sellerNetAmount==null?"Pendente":money(payment.sellerNetAmount),status,new Date(payment.createdAt).toLocaleString("pt-BR")].forEach((v,i)=>{const cell=text(row,"td",String(v)); if(i===6) cell.className=`mp-payment-state state-${String(status).toLowerCase().replace(/[^a-z_]/g,"")}`;}); tbody.append(row); });
      if (!commissions.length) { const row=document.createElement("tr"); const cell=text(row,"td","Nenhum pagamento Mercado Pago registrado.","mp-empty-row"); cell.colSpan=8; tbody.append(row); }
      table.append(thead,tbody); wrap.append(table); noc.append(wrap); root.append(noc);
    } catch (error) { loading.textContent = error.message; loading.className = "mp-loading error"; }
  }
  await render();
};
