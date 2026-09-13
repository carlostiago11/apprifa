const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026090505-mercadopago-scope-text",
  async up({ queryInterface }) {
    await queryInterface.changeColumn("TenantPaymentProviders", "scope", {
      type: DataTypes.TEXT, allowNull: true,
    });
  },
};