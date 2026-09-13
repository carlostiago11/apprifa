const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026090504-mercadopago-scope-length",
  async up({ queryInterface }) {
    await queryInterface.changeColumn("TenantPaymentProviders", "scope", {
      type: DataTypes.TEXT, allowNull: true,
    });
  },
};