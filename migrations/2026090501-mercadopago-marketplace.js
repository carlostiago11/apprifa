const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026090501-mercadopago-marketplace",
  async up({ queryInterface }) {
    const columns = await queryInterface.describeTable("Payments");
    const additions = {
      marketplaceFeePercent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      marketplaceFeeAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      mercadoPagoFeeAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      sellerNetAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      financialStatus: { type: DataTypes.STRING(40), allowNull: true },
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns[name]) await queryInterface.addColumn("Payments", name, definition);
    }
  },
};
