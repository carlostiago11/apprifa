const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026090503-mercadopago-account-requirements",
  async up({ queryInterface }) {
    const columns = await queryInterface.describeTable("TenantPaymentProviders");
    if (!columns.accountHolderType) {
      await queryInterface.addColumn("TenantPaymentProviders", "accountHolderType", {
        type: DataTypes.STRING(2), allowNull: true,
      });
    }
    if (!columns.kycConfirmed) {
      await queryInterface.addColumn("TenantPaymentProviders", "kycConfirmed", {
        type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
      });
    }
  },
};
