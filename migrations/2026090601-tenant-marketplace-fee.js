const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026090601-tenant-marketplace-fee",
  async up({ queryInterface }) {
    const columns = await queryInterface.describeTable("Tenants");
    if (!columns.marketplaceFeePercent) {
      await queryInterface.addColumn("Tenants", "marketplaceFeePercent", {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 10,
      });
    }
  },
};
