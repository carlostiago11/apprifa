const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026090602-raffle-winner-count",
  async up({ queryInterface }) {
    const columns = await queryInterface.describeTable("Raffles");
    if (!columns.winnerCount) {
      await queryInterface.addColumn("Raffles", "winnerCount", {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        defaultValue: 3,
      });
    }
  },
};
