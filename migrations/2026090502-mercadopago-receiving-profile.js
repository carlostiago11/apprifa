const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026090502-mercadopago-receiving-profile",
  async up({ queryInterface }) {
    const columns = await queryInterface.describeTable("TenantPaymentProviders");
    const additions = {
      accountHolderName: { type: DataTypes.STRING(180), allowNull: true },
      accountHolderTaxId: { type: DataTypes.STRING(18), allowNull: true },
      accountEmail: { type: DataTypes.STRING(180), allowNull: true },
      accountPhone: { type: DataTypes.STRING(40), allowNull: true },
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns[name]) await queryInterface.addColumn("TenantPaymentProviders", name, definition);
    }
  },
};
